// Server-authoritative multiplayer music guessing game.
// Single room, max 8 players, 10 rounds.
// The server is the only source of truth: it holds the correct answer,
// runs the round clock, validates guesses, and computes every score.
// The correct answer is NEVER sent to clients while a round is live.

import http from "node:http";
import { Server } from "socket.io";
import { fetchSongs } from "./itunesFetcher.js";

// ----- Configuration -----
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const TOTAL_ROUNDS = 10;
const ROUND_MS = 10000;   // round length, server-side only (10 seconds)
const REVEAL_MS = 3000;   // pause on the reveal screen before next round
// Scoring: question value escalates per round; speed bonus decays linearly.
const QUESTION_BASE = 300;    // round 0 base value
const QUESTION_STEP = 250;    // added per round index
const MAX_SPEED_BONUS = 350;  // full speed bonus for an instant correct answer

// Genres the host may choose (validated server-side; defaults to hip-hop).
const ALLOWED_GENRES = ["hip-hop", "r&b", "rap", "drill", "trap"];

// ----- Game phases (the state machine) -----
// LOBBY -> ROUND_PLAYING -> ROUND_REVEAL -> (loop) -> GAME_OVER
const PHASE = {
  LOBBY: "LOBBY",
  ROUND_PLAYING: "ROUND_PLAYING",
  ROUND_REVEAL: "ROUND_REVEAL",
  GAME_OVER: "GAME_OVER",
};

// ----- Room state (single room, kept in memory) -----
const players = new Map(); // socketId -> { id, name, score, hasGuessed, lastRoundScore, lastCorrect }
const room = {
  phase: PHASE.LOBBY,
  round: 0,
  loading: false,          // true while the song pool is being fetched
  pool: [],                // tracks fetched once for the whole game
  usedTrackIds: new Set(), // correct trackIds already used (distinct per round)
  audioUrl: null,          // current round preview url (safe to send)
  options: [],             // current round's 4 track names (safe to send)
  correct: null,           // current round's correct track name (SERVER-ONLY)
  roundStartedAt: 0,       // server timestamp when the round began
  guesses: new Map(),      // this round's guesses: socketId -> { option, elapsedMs }
  genre: "hip-hop",        // current game's genre/search term (for pool refetch)
  pending: null,           // next round's built data, held during the countdown
  correctArtist: null,     // current round's correct artist (for round history)
  history: [],             // per-round recap: { trackName, artistName, winner }
};

let roundTimer = null;     // fires when the 10s round window closes
let revealTimer = null;    // fires when the reveal pause ends
let countdownTimer = null; // fires when the 3-2-1 countdown ends
let refreshing = false;    // true while a fresh pool is being fetched mid-game

// ----- Helpers -----

// Clear any pending timers so phases never overlap or double-fire.
function clearTimers() {
  if (roundTimer) clearTimeout(roundTimer);
  if (revealTimer) clearTimeout(revealTimer);
  if (countdownTimer) clearTimeout(countdownTimer);
  roundTimer = null;
  revealTimer = null;
  countdownTimer = null;
}

// Trim and bound a player-supplied name. Never trust client input.
function cleanName(raw) {
  const name = String(raw ?? "").trim().slice(0, 20);
  return name.length > 0 ? name : "Player";
}

// Fisher-Yates shuffle so the correct option is never in a fixed slot.
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Build one round from the fetched pool: a correct track plus 3 distractors,
// preferring different artists. Returns track names only (plus the preview url
// and the correct trackId for server-side bookkeeping). The correct answer is
// never flagged -- it is just one of the four shuffled options.
function buildRound(pool, usedTrackIds) {
  // Prefer a correct track not used yet this game, so each round is distinct.
  const unused = pool.filter((t) => !usedTrackIds.has(t.trackId));
  const candidates = unused.length > 0 ? unused : pool;
  const correct = candidates[Math.floor(Math.random() * candidates.length)];

  const usedNames = new Set([correct.trackName]);
  const usedArtists = new Set([correct.artistName]);
  const distractors = [];
  const others = shuffle(pool.filter((t) => t.trackId !== correct.trackId));

  // Pass 1: strictly different artist AND different track name.
  for (const t of others) {
    if (distractors.length === 3) break;
    if (usedArtists.has(t.artistName)) continue;
    if (usedNames.has(t.trackName)) continue;
    distractors.push(t);
    usedArtists.add(t.artistName);
    usedNames.add(t.trackName);
  }
  // Pass 2 (fallback): if the pool lacks enough distinct artists, fill with any
  // distinct-name track so the round still has 4 options.
  if (distractors.length < 3) {
    for (const t of others) {
      if (distractors.length === 3) break;
      if (usedNames.has(t.trackName)) continue;
      distractors.push(t);
      usedNames.add(t.trackName);
    }
  }

  // Shuffle so the correct answer's position is random, no flag attached.
  const options = shuffle([
    correct.trackName,
    ...distractors.map((t) => t.trackName),
  ]);
  return {
    audioUrl: correct.previewUrl,
    options,
    correct: correct.trackName,
    artistName: correct.artistName,
    trackId: correct.trackId,
  };
}

// Question value escalates per round: round 0 = 300, round 1 = 550, round 2 = 800...
function questionValueFor(roundIndex) {
  return QUESTION_BASE + roundIndex * QUESTION_STEP;
}

// Speed bonus decays linearly with the time left when the guess arrived.
// (timeRemaining / roundDuration), clamped to [0, 1].
function speedBonusFor(elapsedMs) {
  const ratio = Math.max(0, Math.min(1, (ROUND_MS - elapsedMs) / ROUND_MS));
  return Math.round(MAX_SPEED_BONUS * ratio);
}

// Streak bonus: 2 correct in a row +50, 3 +100, 4 or more +200 (Feature 2).
function streakBonusFor(streak) {
  if (streak >= 4) return 200;
  if (streak === 3) return 100;
  if (streak === 2) return 50;
  return 0;
}

// Build the public snapshot of game state.
// SECURITY: this serializer omits `room.correct` by construction, so the
// answer can never leak through a state broadcast.
function publicState() {
  const inRound =
    room.phase === PHASE.ROUND_PLAYING || room.phase === PHASE.ROUND_REVEAL;

  return {
    phase: room.phase,
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    maxPlayers: MAX_PLAYERS,
    // Audio + options are only meaningful inside a round.
    audioUrl: inRound ? room.audioUrl : null,
    options: inRound ? room.options : null,
    // Display-only countdown. The server clock is what actually decides scoring.
    timeRemainingMs:
      room.phase === PHASE.ROUND_PLAYING
        ? Math.max(0, ROUND_MS - (Date.now() - room.roundStartedAt))
        : null,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hasGuessed: p.hasGuessed,
      lastRoundScore: p.lastRoundScore,
    })),
  };
}

// Push the current public state to everyone in the room.
function broadcastState() {
  io.emit("state", publicState());
}

// True when every connected player has locked in a guess this round.
function allGuessed() {
  if (players.size === 0) return false;
  for (const p of players.values()) {
    if (!p.hasGuessed) return false;
  }
  return true;
}

// ----- State transitions -----

// Hard reset back to the lobby (used when the room empties).
function resetToLobby() {
  clearTimers();
  room.phase = PHASE.LOBBY;
  room.round = 0;
  room.loading = false;
  room.pool = [];
  room.usedTrackIds = new Set();
  room.audioUrl = null;
  room.options = [];
  room.correct = null;
  room.roundStartedAt = 0;
  room.guesses = new Map();
  room.pending = null;
  room.correctArtist = null;
  room.history = [];
  for (const p of players.values()) {
    p.score = 0;
    p.streak = 0;
    p.hasGuessed = false;
    p.lastRoundScore = 0;
    p.lastCorrect = false;
  }
}

// Begin round `n` with a 3-2-1 countdown, then the audio (Feature 3).
function startRound(n) {
  // If everyone left, do not run a ghost round.
  if (players.size === 0) {
    resetToLobby();
    broadcastState();
    return;
  }

  clearTimers();
  room.round = n;

  // Build this round now, but HOLD it (audio/options/answer) until the
  // countdown ends. The phase stays on the previous screen during the
  // countdown, so the guess handler's phase check rejects any early guess and
  // the upcoming audio never leaks via a state broadcast.
  const picked = buildRound(room.pool, room.usedTrackIds);
  room.usedTrackIds.add(picked.trackId);
  room.pending = picked;

  // Fresh guess state for the new round.
  room.guesses = new Map();
  for (const p of players.values()) {
    p.hasGuessed = false;
    p.lastRoundScore = 0;
    p.lastCorrect = false;
  }

  // SAFE: no correct answer field. Just a 3-2-1 cue.
  io.emit("countdown", { seconds: 3, round: n });
  countdownTimer = setTimeout(beginPlaying, 3000);
}

// Reveal the audio + options and start the round clock (after the countdown).
function beginPlaying() {
  if (players.size === 0 || !room.pending) {
    resetToLobby();
    broadcastState();
    return;
  }
  const picked = room.pending;
  room.pending = null;
  room.phase = PHASE.ROUND_PLAYING;
  room.audioUrl = picked.audioUrl;
  room.options = picked.options;
  room.correct = picked.correct; // SERVER-ONLY
  room.correctArtist = picked.artistName;
  room.roundStartedAt = Date.now();

  const roundIndex = room.round - 1;
  // SAFE: no correct answer field.
  io.emit("roundStart", {
    questionValue: questionValueFor(roundIndex),
    maxSpeedBonus: MAX_SPEED_BONUS,
    roundIndex,
  });

  // Broadcast the round WITHOUT the correct answer.
  broadcastState();
  roundTimer = setTimeout(endRound, ROUND_MS);
}

// Pool top-up: if the pool is nearly exhausted, fetch a fresh one during the
// reveal pause so the next round has new songs ready. Non-blocking; on failure
// the old pool is kept (buildRound falls back to repeats if it must).
async function maybeRefreshPool() {
  if (refreshing) return;
  if (room.usedTrackIds.size < room.pool.length - 4) return;
  refreshing = true;
  try {
    const fresh = await fetchSongs(room.genre, 16);
    if (fresh && fresh.length >= 4) {
      room.pool = fresh;
      room.usedTrackIds = new Set();
    }
  } catch {
    /* keep the existing pool */
  } finally {
    refreshing = false;
  }
}

// Close the current round and show the reveal.
function endRound() {
  clearTimers();
  room.phase = PHASE.ROUND_REVEAL;

  // The round is over: now (and only now) settle every stored guess.
  const correctName = room.correct ?? null;
  const questionValue = questionValueFor(room.round - 1);

  let fastest = null; // fastest CORRECT guess -> round winner
  const results = [...players.values()].map((p) => {
    const g = room.guesses.get(p.id) || null;
    const answered = g != null;
    const isCorrect = answered && g.option === correctName;
    const answerTimeSeconds = answered ? Math.round(g.elapsedMs / 10) / 100 : null;

    // Streak: consecutive correct answers earn an escalating bonus.
    p.streak = isCorrect ? (p.streak || 0) + 1 : 0;
    const streakBonus = isCorrect ? streakBonusFor(p.streak) : 0;

    const pointsEarned = isCorrect
      ? questionValue + speedBonusFor(g.elapsedMs) + streakBonus
      : 0;

    // Apply to running totals now, not mid-round.
    p.score += pointsEarned;
    p.lastRoundScore = pointsEarned;
    p.lastCorrect = isCorrect;

    // Wrong answers never win; track the fastest correct one.
    if (isCorrect && (fastest === null || g.elapsedMs < fastest.elapsedMs)) {
      fastest = { name: p.name, elapsedMs: g.elapsedMs, answerTimeSeconds };
    }

    return {
      id: p.id,
      name: p.name,
      correct: isCorrect,
      pointsEarned,
      streakBonus,
      currentStreak: p.streak,
      answerTimeSeconds,
      score: p.score,
      gained: pointsEarned, // alias kept for the existing client
    };
  });

  const roundWinner = fastest
    ? { name: fastest.name, answerTimeSeconds: fastest.answerTimeSeconds }
    : null;

  const leaderboard = [...players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));

  io.emit("reveal", {
    correct: correctName,
    round: room.round,
    results,
    roundWinner,
    leaderboard,
  });
  broadcastState();

  // During the reveal pause, top up the pool if it is running low so the next
  // round has fresh songs ready (non-blocking).
  maybeRefreshPool();

  // After a short pause, advance to the next round or end the game.
  revealTimer = setTimeout(() => {
    if (players.size === 0) {
      resetToLobby();
      broadcastState();
    } else if (room.round >= TOTAL_ROUNDS) {
      gameOver();
    } else {
      startRound(room.round + 1);
    }
  }, REVEAL_MS);
}

// End the game and publish the final leaderboard.
function gameOver() {
  clearTimers();
  room.phase = PHASE.GAME_OVER;

  const leaderboard = [...players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));

  io.emit("gameOver", { leaderboard });
  broadcastState();
}

// ----- HTTP + Socket.IO server -----
const httpServer = http.createServer((req, res) => {
  // Tiny health endpoint so the process is easy to sanity-check in a browser.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      phase: room.phase,
      round: room.round,
      players: players.size,
    })
  );
});

const io = new Server(httpServer, {
  // Dev-only: allow any origin so a separate client page can connect.
  // Lock this down to your real client origin before deploying.
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  // Always send the joining socket the current state immediately.
  socket.emit("state", publicState());

  // --- join: enter the lobby ---
  socket.on("join", (payload) => {
    if (room.phase !== PHASE.LOBBY) {
      socket.emit("errorMsg", { message: "Game already in progress." });
      return;
    }
    if (players.has(socket.id)) {
      socket.emit("errorMsg", { message: "Already joined." });
      return;
    }
    if (players.size >= MAX_PLAYERS) {
      socket.emit("errorMsg", { message: "Room is full." });
      return;
    }

    players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload && payload.name),
      score: 0,
      streak: 0,
      hasGuessed: false,
      lastRoundScore: 0,
      lastCorrect: false,
    });

    socket.emit("joined", { id: socket.id });
    broadcastState();
  });

  // --- startGame: leave the lobby and play round 1 (optional { genre }) ---
  socket.on("startGame", async (payload) => {
    if (room.phase !== PHASE.LOBBY) {
      socket.emit("errorMsg", { message: "Game already started." });
      return;
    }
    if (!players.has(socket.id)) {
      socket.emit("errorMsg", { message: "Join before starting." });
      return;
    }
    if (players.size < 1) {
      socket.emit("errorMsg", { message: "Need at least one player." });
      return;
    }
    // Guard against a double-start while the async fetch is still in flight.
    if (room.loading) {
      socket.emit("errorMsg", { message: "Game is already starting." });
      return;
    }

    // LOBBY -> ROUND_PLAYING: fetch the song pool once for the whole game.
    room.loading = true;
    io.emit("loading", { message: "Loading songs..." });

    const requested = String(payload?.genre ?? "").toLowerCase();
    room.genre = ALLOWED_GENRES.includes(requested) ? requested : "hip-hop";
    let pool;
    try {
      pool = await fetchSongs(room.genre, 16);
    } catch (err) {
      room.loading = false;
      io.emit("errorMsg", { message: "Could not load songs. Try again." });
      return;
    }
    room.loading = false;

    // Need at least 4 tracks to build 4 options.
    if (!pool || pool.length < 4) {
      io.emit("errorMsg", { message: "Not enough songs to start." });
      return;
    }
    // If everyone left or a game already began while fetching, abort safely.
    if (room.phase !== PHASE.LOBBY || players.size < 1) return;

    room.pool = pool;
    room.usedTrackIds = new Set();
    // Reset scores + streaks for a clean game.
    for (const p of players.values()) {
      p.score = 0;
      p.streak = 0;
    }
    startRound(1);
  });

  // --- guess: submit one answer for the current round ---
  socket.on("guess", (payload) => {
    if (room.phase !== PHASE.ROUND_PLAYING) {
      socket.emit("errorMsg", { message: "No active round." });
      return;
    }
    const player = players.get(socket.id);
    if (!player) {
      socket.emit("errorMsg", { message: "You are not in the game." });
      return;
    }
    // Reject duplicate guesses: one per player per round.
    if (player.hasGuessed) {
      socket.emit("errorMsg", { message: "Already guessed this round." });
      return;
    }

    // Record the guess + when it arrived. Do NOT score or reveal correctness
    // now: no totals move and nothing is settled until the round ends, so
    // results stay fully hidden mid-round.
    const elapsedMs = Date.now() - room.roundStartedAt;
    const choice = payload && payload.option;
    player.hasGuessed = true;
    room.guesses.set(socket.id, { option: choice, elapsedMs });

    // Acknowledge the lock WITHOUT revealing correctness.
    socket.emit("guessAck", { accepted: true });

    broadcastState();

    // If everyone has answered, end the round early.
    if (allGuessed()) endRound();
  });

  // --- restart: from GAME_OVER back to the lobby ---
  socket.on("restart", () => {
    if (room.phase !== PHASE.GAME_OVER) {
      socket.emit("errorMsg", { message: "Game is not over yet." });
      return;
    }
    resetToLobby();
    broadcastState();
  });

  // --- disconnect: drop the player and keep the room consistent ---
  socket.on("disconnect", () => {
    if (!players.has(socket.id)) return;
    players.delete(socket.id);

    if (players.size === 0) {
      // Nobody left: stop all timers and return to a clean lobby.
      resetToLobby();
    } else if (room.phase === PHASE.ROUND_PLAYING && allGuessed()) {
      // The leaver may have been the last one we were waiting on.
      endRound();
      return;
    }

    broadcastState();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Song trivia server listening on http://localhost:${PORT}`);
});
