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

export function useGameSocket() {
  const socketRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState(null);
  const [state, setState] = useState(null); // latest public state snapshot
  const [reveal, setReveal] = useState(null); // last round reveal (answer + deltas)
  const [gameOver, setGameOver] = useState(null); // final leaderboard
  const [loading, setLoading] = useState(null); // { message } while server is busy
  const [error, setError] = useState(null); // transient error message
  const [roundMeta, setRoundMeta] = useState(null); // { questionValue, maxSpeedBonus, roundIndex }

  useEffect(() => {
    // Same-origin connection. In dev, Vite proxies /socket.io to the game
    // server on :3000 (see vite.config.js). In prod, serve client + server
    // from one origin and this still resolves correctly.
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setMyId(socket.id);
    });
    socket.on("disconnect", () => setConnected(false));

    // Server confirms our identity on join.
    socket.on("joined", ({ id }) => setMyId(id));

    // The authoritative state snapshot. Receiving any state ends a loading
    // screen, and entering a fresh round clears the previous reveal.
    socket.on("state", (s) => {
      setState(s);
      setLoading(null);
      if (s.phase === "ROUND_PLAYING") setReveal(null);
      if (s.phase !== "GAME_OVER") setGameOver(null);
    });

    // Round over: server discloses the correct answer + per-player deltas.
    socket.on("reveal", (r) => setReveal(r));

    // Round start: authoritative scoring values for this round's banner.
    socket.on("roundStart", (data) => setRoundMeta(data));

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
  const join = useCallback((name) => socketRef.current?.emit("join", { name }), []);
  const start = useCallback(() => socketRef.current?.emit("start"), []);
  const guess = useCallback((option) => socketRef.current?.emit("guess", { option }), []);
  const restart = useCallback(() => socketRef.current?.emit("restart"), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    connected,
    myId,
    state,
    reveal,
    gameOver,
    loading,
    error,
    roundMeta,
    join,
    start,
    guess,
    restart,
    clearError,
  };
}
