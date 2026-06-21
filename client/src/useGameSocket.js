// useGameSocket — single source of truth for all game state, fed only by the
// server over Socket.IO.
//
// SECURITY / FAIRNESS CONTRACT:
//   - This hook NEVER computes or stores a correct answer. The only place a
//     correct answer exists client-side is the `reveal` payload, which the
//     server sends AFTER a round is over.
//   - This hook NEVER sends a score. It emits exactly four things:
//     join, start, guess, restart.
//   - Every piece of game truth (phase, options, scores, timer) comes from the
//     server. The client only renders it.

import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

// Per-tab session so a refresh or a dropped connection can rejoin the same room
// (with score intact) using the server-issued token. sessionStorage, not local,
// so it's scoped to this tab and clears when the tab closes.
const SESSION_KEY = "snippet.session";
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}
function saveSession(s) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked — rejoin just won't persist */
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function useGameSocket() {
  const socketRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState(null);
  const [roomCode, setRoomCode] = useState(null);
  const [state, setState] = useState(null); // latest public state snapshot
  const [reveal, setReveal] = useState(null); // last round reveal (answer + deltas)
  const [gameOver, setGameOver] = useState(null); // final leaderboard
  const [loading, setLoading] = useState(null); // { message } while server is busy
  const [error, setError] = useState(null); // transient error message
  const [roundMeta, setRoundMeta] = useState(null); // { questionValue, maxSpeedBonus, roundIndex }
  const [countdown, setCountdown] = useState(null); // { seconds, round } during the 3-2-1
  const [notice, setNotice] = useState(null); // transient bottom toast (player left, new host)
  const [messages, setMessages] = useState([]); // room chat log (capped)
  const [reactions, setReactions] = useState([]); // ephemeral floated call-outs
  const seqRef = useRef(0); // monotonic id for stable React keys

  useEffect(() => {
    // In dev, Vite proxies /socket.io to the server on :3000 (same origin). In
    // prod, the deployed client connects to the backend URL from VITE_SOCKET_URL
    // (e.g. your Railway URL).
    const socket = io(import.meta.env.VITE_SOCKET_URL || window.location.origin, {
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setMyId(socket.id);
      // If this tab was already in a room (refresh / dropped connection), try to
      // reclaim the held slot before anything else.
      const s = loadSession();
      if (s && s.code && s.token) socket.emit("rejoin", { code: s.code, token: s.token });
    });
    socket.on("disconnect", () => setConnected(false));

    // Server confirms our room + identity (and a rejoin token to persist).
    socket.on("roomJoined", ({ code, id, token }) => {
      setMyId(id);
      setRoomCode(code);
      if (token) saveSession({ code, token });
    });

    // The held slot was gone (room closed, grace expired) — forget the session.
    socket.on("rejoinFailed", () => clearSession());

    // The authoritative state snapshot. Receiving any state ends a loading
    // screen, and entering a fresh round clears the previous reveal.
    socket.on("state", (s) => {
      setState(s);
      setLoading(null);
      if (s.phase === "ROUND_PLAYING") {
        setReveal(null);
        setCountdown(null);
      }
      if (s.phase !== "GAME_OVER") setGameOver(null);
    });

    // Round over: server discloses the correct answer + per-player deltas.
    socket.on("reveal", (r) => setReveal(r));

    // Round start: authoritative scoring values for this round's banner.
    socket.on("roundStart", (data) => {
      setRoundMeta(data);
      setCountdown(null);
    });

    // 3-2-1 countdown before the audio plays.
    socket.on("countdown", (d) => {
      setCountdown(d || { seconds: 3 });
      setLoading(null);
    });

    // Chat: append (cap to the last 60 messages to bound memory).
    socket.on("chat", (m) => {
      const id = ++seqRef.current;
      setMessages((prev) => [...prev, { ...m, key: id }].slice(-60));
    });

    // Reactions: ephemeral floated call-outs. Each gets a unique key and is
    // auto-removed after its float animation (~1.6s).
    socket.on("reaction", (r) => {
      const key = ++seqRef.current;
      const lane = key % 5; // spread horizontally so simultaneous reacts don't stack
      setReactions((prev) => [...prev, { ...r, key, lane }]);
      setTimeout(() => setReactions((prev) => prev.filter((x) => x.key !== key)), 1600);
    });

    // Room membership notices (Feature 5) -> bottom toast.
    socket.on("playerLeft", (d) =>
      setNotice(d?.held ? `${d?.name || "A player"} dropped — can rejoin` : `${d?.name || "A player"} left`)
    );
    socket.on("newHost", (d) => setNotice(`${d?.name || "Someone"} is now host`));
    socket.on("waitingForPlayers", () => setNotice("Waiting for more players…"));

    // Game over: final leaderboard.
    socket.on("gameOver", (g) => setGameOver(g));

    // Server is fetching songs (or otherwise busy).
    socket.on("loading", (l) => setLoading(l && l.message ? l : { message: "Loading…" }));

    // Recoverable problem (full room, bad action, fetch failed, …).
    socket.on("errorMsg", (e) => {
      setError((e && e.message) || "Something went wrong.");
      setLoading(null);
    });

    return () => {
      socket.close(); // cleanup: tear down the connection on unmount
    };
  }, []);

  // --- The only messages the client may send ---
  const createRoom = useCallback(
    (name, idToken) => socketRef.current?.emit("createRoom", { name, idToken }),
    []
  );
  const joinRoom = useCallback(
    (code, name, idToken) => socketRef.current?.emit("joinRoom", { code, name, idToken }),
    []
  );
  const quickPlay = useCallback(
    (name, idToken) => socketRef.current?.emit("quickPlay", { name, idToken }),
    []
  );
  // settings = { genre, rounds, roundMs, optionsCount, mode, decade }. The server
  // validates/clamps every field; the client only requests.
  const start = useCallback((settings) => socketRef.current?.emit("startGame", settings || {}), []);
  const guess = useCallback((option) => socketRef.current?.emit("guess", { option }), []);
  const restart = useCallback(() => socketRef.current?.emit("restart"), []);
  const sendChat = useCallback((text) => socketRef.current?.emit("chat", { text }), []);
  const sendReaction = useCallback((token) => socketRef.current?.emit("react", { token }), []);
  const clearError = useCallback(() => setError(null), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    connected,
    myId,
    state,
    reveal,
    gameOver,
    loading,
    error,
    roundMeta,
    countdown,
    notice,
    messages,
    reactions,
    roomCode,
    createRoom,
    joinRoom,
    quickPlay,
    start,
    guess,
    restart,
    sendChat,
    sendReaction,
    clearError,
    clearNotice,
  };
}
