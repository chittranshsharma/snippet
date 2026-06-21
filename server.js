// Server-authoritative multiplayer music guessing game — MULTI-ROOM.
//
// Each room (4-char code) is an isolated game with its own state, players, and
// timers. The server is the only source of truth: it holds the correct answer,
// runs the round clock, validates guesses, and computes every score. The
// correct answer is NEVER sent to clients while a round is live.

import http from "node:http";
import { Server } from "socket.io";
import { fetchSongs } from "./itunesFetcher.js";
import { OAuth2Client } from "google-auth-library";

// ----- Configuration -----
const PORT = process.env.PORT || 3000;
// Comma-separated allowlist of client origins (e.g. your Vercel URL). "*" in dev.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((s) => s.trim())
  : "*";
const MAX_PLAYERS = 8;
const TOTAL_ROUNDS = 10;
const ROUND_MS = 10000; // round length, server-side only
const REVEAL_MS = 3000; // pause on the reveal screen before next round
const EARLY_END_GRACE_MS = 3000; // keep the clip playing this long after everyone answers
const QUESTION_BASE = 300;
const QUESTION_STEP = 250;
const MAX_SPEED_BONUS = 350;
const ALLOWED_GENRES = ["hip-hop", "r&b", "rap", "drill", "trap"];

// Google OAuth (optional). If GOOGLE_CLIENT_ID is unset, sign-in is disabled and
// everyone plays as a guest.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ----- Game phases -----
const PHASE = {
  LOBBY: "LOBBY",
  ROUND_PLAYING: "ROUND_PLAYING",
  ROUND_REVEAL: "ROUND_REVEAL",
  GAME_OVER: "GAME_OVER",
};

// ----- Rooms registry: code -> room state -----
const rooms = new Map();

// Codes use an unambiguous alphabet (no 0/O/1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code) {
  return {
    code,
    phase: PHASE.LOBBY,
    round: 0,
    loading: false,
    pool: [],
    usedTrackIds: new Set(),
    audioUrl: null,
    options: [],
    correct: null, // SERVER-ONLY
    roundStartedAt: 0,
    guesses: new Map(), // socketId -> { option, elapsedMs }
    genre: "hip-hop",
    pending: null, // next round's data, held during the countdown
    correctArtist: null,
    history: [], // { trackName, artistName, winner }
    players: new Map(), // socketId -> player
    timers: { round: null, reveal: null, countdown: null },
    refreshing: false,
  };
}

function makePlayer(id, name) {
  return {
    id,
    name,
    google: false,
    email: null, // SERVER-ONLY, never broadcast
    sub: null, // SERVER-ONLY Google subject id
    score: 0,
    streak: 0,
    hasGuessed: false,
    lastRoundScore: 0,
    lastCorrect: false,
  };
}

function roomOf(socket) {
  const code = socket.data && socket.data.roomCode;
  return code ? rooms.get(code) || null : null;
}

function deleteRoom(room) {
  clearTimers(room);
  rooms.delete(room.code);
}

// ----- Pure helpers (room-independent) -----

// S2 (sanitize): allow letters, digits, space, underscore, and hyphen only.
function cleanName(raw) {
  return String(raw ?? "")
    .replace(/[^a-zA-Z0-9 _\-]/g, "")
    .trim()
    .slice(0, 20);
}

// Resolve identity from a create/join payload. With a Google ID token (and
// GOOGLE_CLIENT_ID configured) the token is VERIFIED server-side and the Google
// name is used; otherwise the typed handle is used as a guest.
async function resolveIdentity(payload) {
  const idToken = payload && payload.idToken;
  if (idToken && oauthClient) {
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      const name = cleanName(p.name || p.given_name || (p.email ? p.email.split("@")[0] : ""));
      if (!name) return { error: "Could not read your Google name." };
      return { name, google: true, sub: p.sub, email: p.email || null };
    } catch {
      return { error: "Google sign-in failed. Try again." };
    }
  }
  const name = cleanName(payload && payload.name);
  if (!name) return { error: "Enter a valid handle." };
  return { name, google: false };
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Build one round: a correct track + 3 different-artist distractors.
function buildRound(pool, usedTrackIds) {
  const unused = pool.filter((t) => !usedTrackIds.has(t.trackId));
  const candidates = unused.length > 0 ? unused : pool;
  const correct = candidates[Math.floor(Math.random() * candidates.length)];

  const usedNames = new Set([correct.trackName]);
  const usedArtists = new Set([correct.artistName]);
  const distractors = [];
  const others = shuffle(pool.filter((t) => t.trackId !== correct.trackId));

  for (const t of others) {
    if (distractors.length === 3) break;
    if (usedArtists.has(t.artistName)) continue;
    if (usedNames.has(t.trackName)) continue;
    distractors.push(t);
    usedArtists.add(t.artistName);
    usedNames.add(t.trackName);
  }
  if (distractors.length < 3) {
    for (const t of others) {
      if (distractors.length === 3) break;
      if (usedNames.has(t.trackName)) continue;
      distractors.push(t);
      usedNames.add(t.trackName);
    }
  }

  const options = shuffle([correct.trackName, ...distractors.map((t) => t.trackName)]);
  return {
    audioUrl: correct.previewUrl,
    options,
    correct: correct.trackName,
    artistName: correct.artistName,
    trackId: correct.trackId,
  };
}

function questionValueFor(roundIndex) {
  return QUESTION_BASE + roundIndex * QUESTION_STEP;
}
function speedBonusFor(elapsedMs) {
  const ratio = Math.max(0, Math.min(1, (ROUND_MS - elapsedMs) / ROUND_MS));
  return Math.round(MAX_SPEED_BONUS * ratio);
}
function streakBonusFor(streak) {
  if (streak >= 4) return 200;
  if (streak === 3) return 100;
  if (streak === 2) return 50;
  return 0;
}

// ----- Per-room helpers -----

function clearTimers(room) {
  for (const k of ["round", "reveal", "countdown"]) {
    if (room.timers[k]) clearTimeout(room.timers[k]);
    room.timers[k] = null;
  }
}

// Public snapshot. SECURITY: omits room.correct by construction.
function publicState(room) {
  const inRound = room.phase === PHASE.ROUND_PLAYING || room.phase === PHASE.ROUND_REVEAL;
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    maxPlayers: MAX_PLAYERS,
    audioUrl: inRound ? room.audioUrl : null,
    options: inRound ? room.options : null,
    timeRemainingMs:
      room.phase === PHASE.ROUND_PLAYING ? Math.max(0, ROUND_MS - (Date.now() - room.roundStartedAt)) : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      google: p.google, // verified badge only; email/sub never leave the server
      score: p.score,
      hasGuessed: p.hasGuessed,
      lastRoundScore: p.lastRoundScore,
    })),
  };
}

function broadcastState(room) {
  io.to(room.code).emit("state", publicState(room)); // SAFE: omits room.correct
}

function allGuessed(room) {
  if (room.players.size === 0) return false;
  for (const p of room.players.values()) if (!p.hasGuessed) return false;
  return true;
}

function resetToLobby(room) {
  clearTimers(room);
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
  for (const p of room.players.values()) {
    p.score = 0;
    p.streak = 0;
    p.hasGuessed = false;
    p.lastRoundScore = 0;
    p.lastCorrect = false;
  }
}

// Begin round `n` with a 3-2-1 countdown, then the audio.
function startRound(room, n) {
  if (room.players.size === 0) {
    resetToLobby(room);
    broadcastState(room);
    return;
  }
  clearTimers(room);
  room.round = n;

  const picked = buildRound(room.pool, room.usedTrackIds);
  room.usedTrackIds.add(picked.trackId);
  room.pending = picked;

  room.guesses = new Map();
  for (const p of room.players.values()) {
    p.hasGuessed = false;
    p.lastRoundScore = 0;
    p.lastCorrect = false;
  }

  const qv = questionValueFor(n - 1);
  // SAFE: no correct answer field.
  io.to(room.code).emit("countdown", {
    seconds: 3,
    round: n,
    questionValue: qv,
    maxSpeedBonus: MAX_SPEED_BONUS,
    maxPoints: qv + MAX_SPEED_BONUS,
  });
  room.timers.countdown = setTimeout(() => beginPlaying(room), 3000);
}

function beginPlaying(room) {
  if (room.players.size === 0 || !room.pending) {
    resetToLobby(room);
    broadcastState(room);
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
  io.to(room.code).emit("roundStart", {
    questionValue: questionValueFor(roundIndex),
    maxSpeedBonus: MAX_SPEED_BONUS,
    roundIndex,
  });
  broadcastState(room);
  room.timers.round = setTimeout(() => endRound(room), ROUND_MS);
}

// Everyone answered: let the clip keep playing briefly before the reveal.
function endRoundSoon(room) {
  if (room.phase !== PHASE.ROUND_PLAYING) return;
  const remaining = ROUND_MS - (Date.now() - room.roundStartedAt);
  if (remaining > EARLY_END_GRACE_MS) {
    if (room.timers.round) clearTimeout(room.timers.round);
    room.timers.round = setTimeout(() => endRound(room), EARLY_END_GRACE_MS);
  }
}

async function maybeRefreshPool(room) {
  if (room.refreshing) return;
  if (room.usedTrackIds.size < room.pool.length - 4) return;
  room.refreshing = true;
  try {
    const fresh = await fetchSongs(room.genre, 16);
    if (fresh && fresh.length >= 4) {
      room.pool = fresh;
      room.usedTrackIds = new Set();
    }
  } catch {
    /* keep the existing pool */
  } finally {
    room.refreshing = false;
  }
}

function endRound(room) {
  clearTimers(room);
  room.phase = PHASE.ROUND_REVEAL;

  const correctName = room.correct ?? null;
  const questionValue = questionValueFor(room.round - 1);

  let fastest = null;
  const results = [...room.players.values()].map((p) => {
    const g = room.guesses.get(p.id) || null;
    const answered = g != null;
    const isCorrect = answered && g.option === correctName;
    const answerTimeSeconds = answered ? Math.round(g.elapsedMs / 10) / 100 : null;

    p.streak = isCorrect ? (p.streak || 0) + 1 : 0;
    const streakBonus = isCorrect ? streakBonusFor(p.streak) : 0;
    const pointsEarned = isCorrect ? questionValue + speedBonusFor(g.elapsedMs) + streakBonus : 0;

    p.score += pointsEarned;
    p.lastRoundScore = pointsEarned;
    p.lastCorrect = isCorrect;

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
      gained: pointsEarned,
    };
  });

  const roundWinner = fastest ? { name: fastest.name, answerTimeSeconds: fastest.answerTimeSeconds } : null;

  room.history.push({
    trackName: correctName,
    artistName: room.correctArtist,
    winner: roundWinner ? roundWinner.name : null,
  });

  const leaderboard = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));

  // The round is OVER, so disclosing the answer here is intentional and safe.
  io.to(room.code).emit("reveal", { correct: correctName, round: room.round, results, roundWinner, leaderboard });
  broadcastState(room);

  maybeRefreshPool(room);

  room.timers.reveal = setTimeout(() => {
    if (room.players.size === 0) {
      resetToLobby(room);
      broadcastState(room);
    } else if (room.round >= TOTAL_ROUNDS) {
      gameOver(room);
    } else {
      startRound(room, room.round + 1);
    }
  }, REVEAL_MS);
}

function gameOver(room) {
  clearTimers(room);
  room.phase = PHASE.GAME_OVER;
  const leaderboard = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));
  io.to(room.code).emit("gameOver", { leaderboard, roundHistory: room.history }); // SAFE: round over
  broadcastState(room);
}

// ----- HTTP + Socket.IO -----
const httpServer = http.createServer((req, res) => {
  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
});

const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });

io.on("connection", (socket) => {
  // --- createRoom: open a new room and become host ---
  socket.on("createRoom", async (payload) => {
    if (socket.data.busy || roomOf(socket)) return;
    socket.data.busy = true;
    try {
      const id = await resolveIdentity(payload);
      if (id.error) {
        socket.emit("errorMsg", { message: id.error });
        return;
      }
      if (roomOf(socket)) return;
      const code = makeCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      const player = makePlayer(socket.id, id.name);
      player.google = id.google;
      player.email = id.email || null;
      player.sub = id.sub || null;
      room.players.set(socket.id, player);
      socket.emit("roomJoined", { code, id: socket.id }); // SAFE
      broadcastState(room);
    } finally {
      socket.data.busy = false;
    }
  });

  // --- joinRoom: join an existing room by code ---
  socket.on("joinRoom", async (payload) => {
    if (socket.data.busy || roomOf(socket)) return;
    socket.data.busy = true;
    try {
      const code = String((payload && payload.code) ?? "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        socket.emit("errorMsg", { message: "Room not found." });
        return;
      }
      if (room.phase !== PHASE.LOBBY) {
        socket.emit("errorMsg", { message: "Game already in progress." });
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit("errorMsg", { message: "Room is full." });
        return;
      }
      const id = await resolveIdentity(payload);
      if (id.error) {
        socket.emit("errorMsg", { message: id.error });
        return;
      }
      if (roomOf(socket)) return;
      socket.join(code);
      socket.data.roomCode = code;
      const player = makePlayer(socket.id, id.name);
      player.google = id.google;
      player.email = id.email || null;
      player.sub = id.sub || null;
      room.players.set(socket.id, player);
      socket.emit("roomJoined", { code, id: socket.id }); // SAFE
      broadcastState(room);
    } finally {
      socket.data.busy = false;
    }
  });

  // --- startGame: host starts round 1 (optional { genre }) ---
  socket.on("startGame", async (payload) => {
    const room = roomOf(socket);
    if (!room) {
      socket.emit("errorMsg", { message: "Not in a room." });
      return;
    }
    if (room.phase !== PHASE.LOBBY) {
      socket.emit("errorMsg", { message: "Game already started." });
      return;
    }
    if (!room.players.has(socket.id)) return;
    if ([...room.players.keys()][0] !== socket.id) {
      socket.emit("errorMsg", { message: "Only the host can start." });
      return;
    }
    if (room.loading) {
      socket.emit("errorMsg", { message: "Game is already starting." });
      return;
    }

    room.loading = true;
    io.to(room.code).emit("loading", { message: "Loading songs..." }); // SAFE

    const requested = String((payload && payload.genre) ?? "").toLowerCase();
    room.genre = ALLOWED_GENRES.includes(requested) ? requested : "hip-hop";
    let pool;
    try {
      pool = await fetchSongs(room.genre, 16);
    } catch {
      room.loading = false;
      io.to(room.code).emit("errorMsg", { message: "Could not load songs. Try again." });
      return;
    }
    room.loading = false;

    if (!pool || pool.length < 4) {
      io.to(room.code).emit("errorMsg", { message: "Not enough songs to start." });
      return;
    }
    if (room.phase !== PHASE.LOBBY || room.players.size < 1) return;

    room.pool = pool;
    room.usedTrackIds = new Set();
    room.history = [];
    for (const p of room.players.values()) {
      p.score = 0;
      p.streak = 0;
    }
    startRound(room, 1);
  });

  // --- guess: one answer per player per round ---
  socket.on("guess", (payload) => {
    const room = roomOf(socket);
    if (!room || room.phase !== PHASE.ROUND_PLAYING) {
      socket.emit("errorMsg", { message: "No active round." });
      return;
    }
    const player = room.players.get(socket.id);
    if (!player) {
      socket.emit("errorMsg", { message: "You are not in the game." });
      return;
    }
    // S1 (rate limit): one guess per player per round.
    if (player.hasGuessed) {
      socket.emit("errorMsg", { message: "Already guessed this round." });
      return;
    }
    const elapsedMs = Date.now() - room.roundStartedAt;
    const choice = payload && payload.option;
    player.hasGuessed = true;
    room.guesses.set(socket.id, { option: choice, elapsedMs });

    socket.emit("guessAck", { accepted: true }); // SAFE
    broadcastState(room);
    if (allGuessed(room)) endRoundSoon(room);
  });

  // --- restart: from GAME_OVER back to the room lobby ---
  socket.on("restart", () => {
    const room = roomOf(socket);
    if (!room || room.phase !== PHASE.GAME_OVER) {
      socket.emit("errorMsg", { message: "Game is not over yet." });
      return;
    }
    resetToLobby(room);
    broadcastState(room);
  });

  // --- disconnect ---
  socket.on("disconnect", () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const wasHost = [...room.players.keys()][0] === socket.id;
    const name = player.name;
    room.players.delete(socket.id);

    io.to(room.code).emit("playerLeft", { name }); // SAFE

    if (room.players.size === 0) {
      deleteRoom(room); // empty room is discarded
      return;
    }
    if (wasHost) {
      const next = room.players.values().next().value;
      if (next) io.to(room.code).emit("newHost", { name: next.name }); // SAFE
    }
    if (room.players.size === 1 && (room.phase === PHASE.ROUND_PLAYING || room.phase === PHASE.ROUND_REVEAL)) {
      io.to(room.code).emit("waitingForPlayers", {}); // SAFE
    }
    if (room.phase === PHASE.ROUND_PLAYING && allGuessed(room)) endRoundSoon(room);
    broadcastState(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Snippet server listening on :${PORT} (origins: ${JSON.stringify(CLIENT_ORIGIN)})`);
});
