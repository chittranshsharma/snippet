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
  const [roomCode, setRoomCode] = useState(null);
  const [state, setState] = useState(null); // latest public state snapshot
  const [reveal, setReveal] = useState(null); // last round reveal (answer + deltas)
  const [gameOver, setGameOver] = useState(null); // final leaderboard
  const [loading, setLoading] = useState(null); // { message } while server is busy
  const [error, setError] = useState(null); // transient error message
  const [roundMeta, setRoundMeta] = useState(null); // { questionValue, maxSpeedBonus, roundIndex }
  const [countdown, setCountdown] = useState(null); // { seconds, round } during the 3-2-1
  const [notice, setNotice] = useState(null); // transient bottom toast (player left, new host)

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
    });
    socket.on("disconnect", () => setConnected(false));

    // Server confirms our room + identity.
    socket.on("roomJoined", ({ code, id }) => {
      setMyId(id);
      setRoomCode(code);
    });

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

    // Room membership notices (Feature 5) -> bottom toast.
    socket.on("playerLeft", (d) => setNotice(`${d?.name || "A player"} left`));
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
  const start = useCallback((genre) => socketRef.current?.emit("startGame", { genre }), []);
  const guess = useCallback((option) => socketRef.current?.emit("guess", { option }), []);
  const restart = useCallback(() => socketRef.current?.emit("restart"), []);
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
    roomCode,
    createRoom,
    joinRoom,
    start,
    guess,
    restart,
    clearError,
    clearNotice,
  };
}
