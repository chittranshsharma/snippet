// Server-authoritative multiplayer music guessing game — MULTI-ROOM.
//
// Each room (4-char code) is an isolated game with its own state, players, and
// timers. The server is the only source of truth: it holds the correct answer,
// runs the round clock, validates guesses, and computes every score. The
// correct answer is NEVER sent to clients while a round is live.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { fetchSongs } from "./itunesFetcher.js";
import { OAuth2Client } from "google-auth-library";
import { maskProfanity } from "./profanity.js";
import {
  DEFAULT_SETTINGS,
  MAX_SPEED_BONUS,
  sanitizeSettings,
  poolSizeFor,
  cleanName,
  buildRound,
  questionValueFor,
  speedBonusFor,
  streakBonusFor,
} from "./gameLogic.js";
import { log } from "./log.js";
import { initStorage, recordMatch, topScores } from "./storage.js";

// ----- Configuration -----
const PORT = process.env.PORT || 3000;
// Comma-separated allowlist of client origins (e.g. your Vercel URL). "*" in dev.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((s) => s.trim())
  : "*";
const MAX_PLAYERS = 8;
const MAX_SPECTATORS = 16; // watchers allowed per room (don't count toward MAX_PLAYERS)
const REJOIN_GRACE_MS = 60000; // hold a disconnected player's slot this long mid-game
const REVEAL_MS = 3000; // pause on the reveal screen before next round
const EARLY_END_GRACE_MS = 3000; // keep the clip playing this long after everyone answers
// Chat + reactions. Reactions are a fixed whitelist of arcade-style call-outs
// (typographic, not emoji — keeps the §12 design rule) floated over the game.
// Match settings, scoring, and round-building live in ./gameLogic.js (imported
// above) so they can be unit-tested without a running server.
const REACTIONS = ["GG", "WOW", "!!", "??", "★", "♥"];
const CHAT_MAX_LEN = 200;

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
    correct: null, // SERVER-ONLY — the gradable answer (title or artist)
    roundStartedAt: 0,
    guesses: new Map(), // socketId -> { option, elapsedMs }
    settings: { ...DEFAULT_SETTINGS }, // host-chosen, validated at startGame
    pending: null, // next round's data, held during the countdown
    correctArtist: null,
    correctTrackName: null,
    history: [], // { trackName, artistName, winner }
    players: new Map(), // socketId -> player
    timers: { round: null, reveal: null, countdown: null },
    refreshing: false,
    isPublic: false, // listed for quick-play matchmaking
    disconnectGrace: new Map(), // rejoin token -> grace timeout
  };
}

// A stable per-session token lets a player rejoin after a disconnect with their
// score intact (socket ids change on reconnect, this does not).
function makeToken() {
  return randomUUID();
}

function makePlayer(id, name) {
  return {
    id,
    name,
    google: false,
    email: null, // SERVER-ONLY, never broadcast
    sub: null, // SERVER-ONLY Google subject id
    picture: null, // public Google avatar URL (safe to broadcast), or null
    token: null, // SERVER-ONLY rejoin token (never broadcast)
    connected: true, // false while held during the rejoin grace window
    spectator: false, // joined mid-game; watches, cannot guess or score
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

// Per-socket sliding-window rate limiter. Returns true if the action should be
// DROPPED (limit exceeded). Used for chat/reactions/connection abuse.
function rateLimited(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.rl = socket.data.rl || {};
  const hits = (socket.data.rl[key] || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    socket.data.rl[key] = hits;
    return true;
  }
  hits.push(now);
  socket.data.rl[key] = hits;
  return false;
}

// ----- Membership helpers -----

function playerCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.spectator) n++;
  return n;
}
function spectatorCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.spectator) n++;
  return n;
}

// Create a player, set identity + a rejoin token, and add them to the room.
// Used by createRoom, joinRoom (incl. spectators), and quickPlay.
function attachPlayer(room, socket, id, opts = {}) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  const player = makePlayer(socket.id, id.name);
  player.google = id.google;
  player.email = id.email || null;
  player.sub = id.sub || null;
  player.picture = id.picture || null;
  player.token = makeToken();
  player.spectator = Boolean(opts.spectator);
  socket.data.token = player.token;
  room.players.set(socket.id, player);
  socket.emit("roomJoined", { code: room.code, id: socket.id, token: player.token, spectator: player.spectator });
  return player;
}

// Re-key a player from an old socket id to a new one, preserving insertion
// order (so host order is stable) and moving any in-flight guess.
function rekeyPlayer(room, oldId, newId) {
  if (oldId === newId) return;
  const rebuilt = new Map();
  for (const [id, p] of room.players) {
    if (id === oldId) {
      p.id = newId;
      rebuilt.set(newId, p);
    } else {
      rebuilt.set(id, p);
    }
  }
  room.players = rebuilt;
  if (room.guesses.has(oldId)) {
    room.guesses.set(newId, room.guesses.get(oldId));
    room.guesses.delete(oldId);
  }
}

// Remove a player for good (grace expired, or an immediate leave), handling host
// transfer, empty-room cleanup, and mid-game "waiting" notices.
function finalizeLeave(room, id) {
  const player = room.players.get(id);
  if (!player) return;
  if (player.token) {
    const t = room.disconnectGrace.get(player.token);
    if (t) {
      clearTimeout(t);
      room.disconnectGrace.delete(player.token);
    }
  }
  const wasHost = !player.spectator && [...room.players.keys()][0] === id;
  const name = player.name;
  room.players.delete(id);
  io.to(room.code).emit("playerLeft", { name }); // SAFE

  if (room.players.size === 0) {
    deleteRoom(room);
    return;
  }
  if (wasHost) {
    const next = [...room.players.values()].find((p) => !p.spectator);
    if (next) io.to(room.code).emit("newHost", { name: next.name }); // SAFE
  }
  const activePlayers = [...room.players.values()].filter((p) => !p.spectator && p.connected);
  if (activePlayers.length === 1 && (room.phase === PHASE.ROUND_PLAYING || room.phase === PHASE.ROUND_REVEAL)) {
    io.to(room.code).emit("waitingForPlayers", {}); // SAFE
  }
  if (room.phase === PHASE.ROUND_PLAYING && allGuessed(room)) endRoundSoon(room);
  broadcastState(room);
}

// ----- Identity (room-independent) -----

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
      const picture = typeof p.picture === "string" && p.picture.startsWith("https://") ? p.picture : null;
      return { name, google: true, sub: p.sub, email: p.email || null, picture };
    } catch {
      return { error: "Google sign-in failed. Try again." };
    }
  }
  const name = cleanName(payload && payload.name);
  if (!name) return { error: "Enter a valid handle." };
  return { name, google: false };
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
    totalRounds: room.settings.rounds,
    roundMs: room.settings.roundMs, // round length, so the client bar matches
    mode: room.settings.mode, // TITLE | ARTIST — for client labels only
    maxPlayers: MAX_PLAYERS,
    isPublic: room.isPublic,
    audioUrl: inRound ? room.audioUrl : null,
    options: inRound ? room.options : null,
    timeRemainingMs:
      room.phase === PHASE.ROUND_PLAYING
        ? Math.max(0, room.settings.roundMs - (Date.now() - room.roundStartedAt))
        : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      google: p.google, // verified badge only; email/sub never leave the server
      avatar: p.picture, // public Google photo URL or null (guests render an initial)
      spectator: p.spectator, // watching, not scoring
      connected: p.connected, // false while held during a rejoin grace window
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
  const active = [...room.players.values()].filter((p) => !p.spectator && p.connected);
  if (active.length === 0) return false;
  for (const p of active) if (!p.hasGuessed) return false;
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
  room.correctTrackName = null;
  room.history = [];
  // room.settings is intentionally preserved so "play again" keeps the host's
  // last choices.
  for (const t of room.disconnectGrace.values()) clearTimeout(t);
  room.disconnectGrace.clear();
  for (const p of room.players.values()) {
    p.score = 0;
    p.streak = 0;
    p.hasGuessed = false;
    p.lastRoundScore = 0;
    p.lastCorrect = false;
    p.connected = true;
    p.spectator = false; // promote any watchers into the rematch
  }
}

// Begin round `n` with a 3-2-1 countdown, then the audio.
function startRound(room, n) {
  if (playerCount(room) === 0) {
    resetToLobby(room);
    broadcastState(room);
    return;
  }
  clearTimers(room);
  room.round = n;

  const picked = buildRound(room.pool, room.usedTrackIds, room.settings);
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
  if (playerCount(room) === 0 || !room.pending) {
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
  room.correctTrackName = picked.trackName;
  room.roundStartedAt = Date.now();

  const roundIndex = room.round - 1;
  // SAFE: no correct answer field.
  io.to(room.code).emit("roundStart", {
    questionValue: questionValueFor(roundIndex),
    maxSpeedBonus: MAX_SPEED_BONUS,
    roundIndex,
  });
  broadcastState(room);
  room.timers.round = setTimeout(() => endRound(room), room.settings.roundMs);
}

// Everyone answered: let the clip keep playing briefly before the reveal.
function endRoundSoon(room) {
  if (room.phase !== PHASE.ROUND_PLAYING) return;
  const remaining = room.settings.roundMs - (Date.now() - room.roundStartedAt);
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
    const fresh = await fetchSongs(room.settings.genre, poolSizeFor(room.settings), {
      decade: room.settings.decade,
    });
    if (fresh && fresh.length >= room.settings.optionsCount) {
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
  const scoring = [...room.players.values()].filter((p) => !p.spectator);
  const results = scoring.map((p) => {
    const g = room.guesses.get(p.id) || null;
    const answered = g != null;
    const isCorrect = answered && g.option === correctName;
    const answerTimeSeconds = answered ? Math.round(g.elapsedMs / 10) / 100 : null;

    p.streak = isCorrect ? (p.streak || 0) + 1 : 0;
    const streakBonus = isCorrect ? streakBonusFor(p.streak) : 0;
    const pointsEarned = isCorrect
      ? questionValue + speedBonusFor(g.elapsedMs, room.settings.roundMs) + streakBonus
      : 0;

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
    trackName: room.correctTrackName,
    artistName: room.correctArtist,
    winner: roundWinner ? roundWinner.name : null,
  });

  const leaderboard = scoring
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));

  // The round is OVER, so disclosing the answer here is intentional and safe.
  // `correct` is the gradable value (title or artist); `track` always carries
  // both so the client can show the full song regardless of mode.
  io.to(room.code).emit("reveal", {
    correct: correctName,
    track: { trackName: room.correctTrackName, artistName: room.correctArtist },
    mode: room.settings.mode,
    round: room.round,
    totalRounds: room.settings.rounds,
    results,
    roundWinner,
    leaderboard,
  });
  broadcastState(room);

  maybeRefreshPool(room);

  room.timers.reveal = setTimeout(() => {
    if (playerCount(room) === 0) {
      resetToLobby(room);
      broadcastState(room);
    } else if (room.round >= room.settings.rounds) {
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
    .filter((p) => !p.spectator)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));
  io.to(room.code).emit("gameOver", { leaderboard, roundHistory: room.history }); // SAFE: round over
  broadcastState(room);
  // Persist final scores for the global leaderboard (no-op without DATABASE_URL).
  recordMatch({ players: [...room.players.values()], settings: room.settings }, log);
}

// ----- HTTP + Socket.IO -----
const httpServer = http.createServer(async (req, res) => {
  const cors = Array.isArray(CLIENT_ORIGIN) ? CLIENT_ORIGIN[0] : CLIENT_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", cors || "*");

  // Global leaderboard (only meaningful when DATABASE_URL is configured).
  if (req.method === "GET" && req.url && req.url.startsWith("/leaderboard")) {
    const rows = await topScores(20);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ leaderboard: rows }));
    return;
  }

  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
});

const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });

// ----- Optional, env-gated scale/observability hooks -----
// Each is DORMANT unless its env var is set AND the package is installed. They
// degrade to a warning and never block the game.

// Redis adapter: fans out socket broadcasts across multiple backend instances.
// NOTE: room/game state still lives in this process's memory, so players in the
// same room must reach the same instance (use sticky sessions). This is the
// groundwork for full horizontal scale, not a complete multi-instance story.
async function maybeAttachRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const [{ createAdapter }, { default: IORedis }] = await Promise.all([
      import("@socket.io/redis-adapter"),
      import("ioredis"),
    ]);
    const pub = new IORedis(url);
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
    log.info("redis adapter attached");
  } catch (e) {
    log.warn("REDIS_URL set but adapter not attached; install @socket.io/redis-adapter + ioredis", {
      error: String((e && e.message) || e),
    });
  }
}

// Sentry error monitoring (optional). Captures uncaught errors if configured.
let sentry = null;
async function maybeInitSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    sentry = await import("@sentry/node");
    sentry.init({ dsn, tracesSampleRate: 0 });
    log.info("sentry initialized");
  } catch (e) {
    log.warn("SENTRY_DSN set but @sentry/node not installed", { error: String((e && e.message) || e) });
  }
}

maybeAttachRedis();
maybeInitSentry();
initStorage(log);

// Last-resort safety nets: log (and report) instead of crashing silently.
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: String((err && err.stack) || err) });
  if (sentry) try { sentry.captureException(err); } catch {}
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { error: String(reason) });
  if (sentry) try { sentry.captureException(reason); } catch {}
});

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
      room.isPublic = Boolean(payload && payload.public);
      rooms.set(code, room);
      attachPlayer(room, socket, id);
      broadcastState(room);
    } finally {
      socket.data.busy = false;
    }
  });

  // --- joinRoom: join by code. In LOBBY you join as a player; once a game is in
  // progress you join as a spectator (watch only). ---
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
      const asSpectator = room.phase !== PHASE.LOBBY;
      if (!asSpectator && playerCount(room) >= MAX_PLAYERS) {
        socket.emit("errorMsg", { message: "Room is full." });
        return;
      }
      if (asSpectator && spectatorCount(room) >= MAX_SPECTATORS) {
        socket.emit("errorMsg", { message: "Too many spectators." });
        return;
      }
      const id = await resolveIdentity(payload);
      if (id.error) {
        socket.emit("errorMsg", { message: id.error });
        return;
      }
      if (roomOf(socket)) return;
      attachPlayer(room, socket, id, { spectator: asSpectator });
      broadcastState(room);
    } finally {
      socket.data.busy = false;
    }
  });

  // --- quickPlay: matchmaking. Join an open public lobby, or open a new one. ---
  socket.on("quickPlay", async (payload) => {
    if (socket.data.busy || roomOf(socket)) return;
    socket.data.busy = true;
    try {
      const id = await resolveIdentity(payload);
      if (id.error) {
        socket.emit("errorMsg", { message: id.error });
        return;
      }
      if (roomOf(socket)) return;
      let room = null;
      for (const r of rooms.values()) {
        if (r.isPublic && r.phase === PHASE.LOBBY && playerCount(r) < MAX_PLAYERS) {
          room = r;
          break;
        }
      }
      if (!room) {
        const code = makeCode();
        room = makeRoom(code);
        room.isPublic = true;
        rooms.set(code, room);
      }
      attachPlayer(room, socket, id);
      broadcastState(room);
    } finally {
      socket.data.busy = false;
    }
  });

  // --- rejoin: reattach to a held slot after a disconnect, score intact. ---
  socket.on("rejoin", (payload) => {
    if (roomOf(socket)) return;
    const code = String((payload && payload.code) ?? "").toUpperCase().trim();
    const token = String((payload && payload.token) ?? "");
    const room = rooms.get(code);
    if (!room || !token) {
      socket.emit("rejoinFailed", {});
      return;
    }
    let target = null;
    for (const p of room.players.values()) {
      if (p.token === token) {
        target = p;
        break;
      }
    }
    if (!target) {
      socket.emit("rejoinFailed", {});
      return;
    }
    const oldId = target.id;
    rekeyPlayer(room, oldId, socket.id);
    target.connected = true;
    const grace = room.disconnectGrace.get(token);
    if (grace) {
      clearTimeout(grace);
      room.disconnectGrace.delete(token);
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.token = token;
    socket.emit("roomJoined", { code: room.code, id: socket.id, token, spectator: target.spectator }); // SAFE
    // Re-send the current phase's payload so the rejoiner's UI is correct.
    if (room.phase === PHASE.GAME_OVER) {
      socket.emit("gameOver", {
        leaderboard: [...room.players.values()]
          .filter((p) => !p.spectator)
          .sort((a, b) => b.score - a.score)
          .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score })),
        roundHistory: room.history,
      });
    }
    broadcastState(room);
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

    // The host's requested settings are validated/clamped here — never trusted.
    room.settings = sanitizeSettings(payload);
    let pool;
    try {
      pool = await fetchSongs(room.settings.genre, poolSizeFor(room.settings), {
        decade: room.settings.decade,
      });
    } catch {
      room.loading = false;
      io.to(room.code).emit("errorMsg", { message: "Could not load songs. Try again." });
      return;
    }
    room.loading = false;

    if (!pool || pool.length < room.settings.optionsCount) {
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
    if (player.spectator) {
      socket.emit("errorMsg", { message: "Spectators can't guess." });
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

  // --- chat: room-scoped messages, rate-limited, sanitized, profanity-masked ---
  socket.on("chat", (payload) => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (rateLimited(socket, "chat", 5, 5000)) return; // drop quietly when flooding
    let text = String((payload && payload.text) ?? "")
      .replace(/[\x00-\x1F\x7F]/g, "") // strip control chars
      .trim()
      .slice(0, CHAT_MAX_LEN);
    if (!text) return;
    text = maskProfanity(text);
    io.to(room.code).emit("chat", { id: socket.id, name: player.name, text, ts: Date.now() }); // SAFE
  });

  // --- react: floated arcade call-out from the whitelist, rate-limited ---
  socket.on("react", (payload) => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (rateLimited(socket, "react", 8, 5000)) return;
    const token = String((payload && payload.token) ?? "");
    if (!REACTIONS.includes(token)) return;
    io.to(room.code).emit("reaction", { id: socket.id, name: player.name, token, ts: Date.now() }); // SAFE
  });

  // --- disconnect ---
  socket.on("disconnect", () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const midGame = room.phase === PHASE.ROUND_PLAYING || room.phase === PHASE.ROUND_REVEAL;
    // Mid-game players keep their slot (and score) for a grace window so they
    // can rejoin with their token. Spectators and lobby/game-over leavers go now.
    if (midGame && !player.spectator && player.token) {
      player.connected = false;
      io.to(room.code).emit("playerLeft", { name: player.name, held: true }); // SAFE
      const token = player.token;
      const heldId = socket.id;
      const timer = setTimeout(() => finalizeLeave(room, heldId), REJOIN_GRACE_MS);
      room.disconnectGrace.set(token, timer);
      if (room.phase === PHASE.ROUND_PLAYING && allGuessed(room)) endRoundSoon(room);
      broadcastState(room);
      return;
    }
    finalizeLeave(room, socket.id);
  });
});

httpServer.listen(PORT, () => {
  log.info("snippet server listening", { port: Number(PORT), origins: CLIENT_ORIGIN });
});
