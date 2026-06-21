// App — React client for the multiplayer music guessing game.
//
// Design: monochrome "mixtape J-card" — ink/bone/concrete, hairline borders,
// zero radius, uppercase mono labels. The one bold element is the tape-counter
// timecode. Green/red are used ONLY to mark answers on reveal, never as decor.
//
// Client rules honored here:
//   - Never stores/computes the correct answer (only reads reveal.correct,
//     which arrives after the round ends).
//   - Never sends a score. Only join/start/guess/restart leave the client.
//   - All game truth comes from the server via useGameSocket.

import { useEffect, useRef, useState } from "react";
import { useGameSocket } from "./useGameSocket";

// ---- Shared class fragments (kept consistent across screens) ----
const EYEBROW = "font-mono text-[11px] uppercase tracking-[0.3em] text-zinc-500";
const PANEL = "border border-zinc-800 bg-zinc-950";
const BTN =
  "border border-zinc-100 px-5 py-3 font-mono text-sm uppercase tracking-[0.2em] " +
  "text-zinc-100 transition-colors hover:bg-zinc-100 hover:text-black " +
  "focus:outline-none focus:ring-2 focus:ring-zinc-100 focus:ring-offset-2 focus:ring-offset-black " +
  "disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-600 disabled:hover:bg-transparent";

// Fallback scoring constants, mirroring server.js. The banner now reads the
// authoritative values from the server's roundStart event (hook roundMeta);
// these are only used if that event hasn't arrived yet.
const QUESTION_BASE = 300;
const QUESTION_STEP = 250;
const MAX_SPEED_BONUS = 350;

// Genre options the host can pick before starting (Feature 1).
const GENRES = ["HIP-HOP", "R&B", "RAP", "DRILL", "TRAP"];

export default function App() {
  const {
    connected, myId, state, reveal, gameOver, loading, error, roundMeta,
    join, start, guess, restart, clearError,
  } = useGameSocket();

  const phase = state?.phase ?? "LOBBY";
  const players = state?.players ?? [];
  const me = players.find((p) => p.id === myId) || null;
  const joined = Boolean(me);
  // No host concept on the server: treat the first player in the list as host.
  const isHost = players.length > 0 && players[0].id === myId;

  // Our own guess for the round (our choice — NOT the answer). Reset each round.
  const [myGuess, setMyGuess] = useState(null);
  const round = state?.round ?? 0;
  useEffect(() => {
    setMyGuess(null);
  }, [round]);

  // Auto-dismiss transient errors.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 3500);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 antialiased selection:bg-zinc-100 selection:text-black">
      {error && <ErrorBar message={error} />}
      {loading && <LoadingOverlay message={loading.message} />}

      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5 pt-6 pb-8">
        <Masthead phase={phase} round={round} total={state?.totalRounds} />

        <main className="flex flex-1 flex-col justify-start py-8">
          {!connected ? (
            <Centered eyebrow="Status" title="Connecting…" />
          ) : !joined ? (
            <JoinScreen onJoin={join} />
          ) : phase === "LOBBY" ? (
            <Lobby players={players} myId={myId} isHost={isHost} onStart={start} />
          ) : phase === "ROUND_PLAYING" ? (
            <Playing
              state={state}
              roundMeta={roundMeta}
              myGuess={myGuess}
              hasGuessed={Boolean(myGuess) || Boolean(me?.hasGuessed)}
              onGuess={(opt) => {
                setMyGuess(opt);
                guess(opt);
              }}
            />
          ) : phase === "ROUND_REVEAL" ? (
            <Reveal reveal={reveal} myId={myId} />
          ) : phase === "GAME_OVER" ? (
            <GameOver gameOver={gameOver} players={players} onRestart={restart} />
          ) : null}
        </main>

        <footer className={`${EYEBROW} flex items-center justify-between border-t border-zinc-900 pt-4`}>
          <span>{connected ? "● Online" : "○ Offline"}</span>
          <span>{me ? me.name : "Guest"}</span>
        </footer>
      </div>
    </div>
  );
}

// ---------- Masthead ----------
function Masthead({ phase, round, total }) {
  const label =
    phase === "ROUND_PLAYING" || phase === "ROUND_REVEAL"
      ? `Track ${String(round).padStart(2, "0")} / ${String(total ?? 10).padStart(2, "0")}`
      : phase === "GAME_OVER"
      ? "Side B · Final"
      : "Side A · Lobby";
  return (
    <header className="flex items-end justify-between border-b border-zinc-800 pb-4">
      <h1 className="text-2xl font-black uppercase leading-none tracking-tighter sm:text-3xl">
        Name<span className="text-zinc-600">·</span>That<span className="text-zinc-600">·</span>Track
      </h1>
      <span className={EYEBROW}>{label}</span>
    </header>
  );
}

// ---------- Join ----------
function JoinScreen({ onJoin }) {
  const [name, setName] = useState("");
  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (n) onJoin(n);
  };
  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-sm">
      <p className={EYEBROW}>Step in</p>
      <h2 className="mt-2 text-4xl font-black uppercase tracking-tighter">Tag in.</h2>
      <p className="mt-2 font-mono text-sm text-zinc-500">Pick a handle to enter the cypher.</p>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={20}
        placeholder="YOUR HANDLE"
        aria-label="Your handle"
        className="mt-8 w-full rounded-none border-0 border-b-2 border-zinc-500 bg-transparent px-1 py-3 font-mono text-lg uppercase tracking-widest placeholder:text-zinc-600 focus:border-white focus:outline-none"
      />
      <button
        type="submit"
        disabled={!name.trim()}
        className="mt-6 w-full bg-white px-5 py-4 font-mono text-sm uppercase tracking-[0.2em] text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        Enter
      </button>
    </form>
  );
}

// ---------- Lobby ----------
function Lobby({ players, myId, isHost, onStart }) {
  const url = typeof window !== "undefined" ? window.location.href : "";
  const [copied, setCopied] = useState(false);
  const [genre, setGenre] = useState("HIP-HOP");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  };

  const shortUrl = url.length > 40 ? url.slice(0, 39) + "…" : url;

  return (
    <div className="space-y-8">
      <div>
        <p className={EYEBROW}>{players.length} / 8 players</p>
        <ul className={`mt-3 ${PANEL} divide-y divide-zinc-900`}>
          {players.map((p, i) => (
            <li
              key={p.id}
              className={`flex items-center justify-between px-4 py-3 ${i % 2 === 0 ? "bg-zinc-900" : "bg-zinc-800"}`}
            >
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs text-zinc-600">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-mono uppercase tracking-wide">{p.name}</span>
              </span>
              <span className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em]">
                {p.id === myId && <span className="text-zinc-400">You</span>}
                {i === 0 && <span className="text-amber-400">[Host]</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className={EYEBROW}>Share the room</p>
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            value={shortUrl}
            title={url}
            onFocus={(e) => e.target.select()}
            aria-label="Room URL"
            className="min-w-0 flex-1 border border-zinc-800 bg-zinc-950 px-3 py-3 font-mono text-xs text-zinc-400 focus:outline-none"
          />
          <button onClick={copy} className={BTN}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {isHost ? (
        <div className="space-y-4">
          <div>
            <p className={EYEBROW}>Genre</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {GENRES.map((g) => {
                const active = g === genre;
                return (
                  <button
                    key={g}
                    onClick={() => setGenre(g)}
                    className={`px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] transition-colors ${
                      active
                        ? "bg-white text-black"
                        : "border border-zinc-600 text-zinc-400 hover:border-zinc-400"
                    }`}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          </div>
          <button onClick={() => onStart(genre.toLowerCase())} className={`${BTN} w-full py-5 text-base`}>
            ▶ Start Game
          </button>
        </div>
      ) : (
        <p className={`${EYEBROW} text-center`}>Waiting for host to drop the needle…</p>
      )}
    </div>
  );
}

// ---------- Playing ----------
function Playing({ state, roundMeta, myGuess, hasGuessed, onGuess }) {
  const audioRef = useRef(null);
  const startRef = useRef(() => {});
  const [needsTap, setNeedsTap] = useState(false);
  const [audioError, setAudioError] = useState(false);

  // Play a 10-second snippet from a random offset that always leaves room.
  // Seeking needs loaded metadata, so wait for it if the clip isn't ready yet.
  // The snippet auto-starts; if the browser blocks playback, show a tap
  // fallback that runs the exact same start logic.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    let pauseTimer = null;

    const start = () => {
      try {
        // Random offset that always leaves room for the 10s snippet.
        const maxOffset = Math.max(0, el.duration - 10);
        el.currentTime = Math.random() * Math.min(15, maxOffset);
      } catch {
        /* not seekable yet; the loadedmetadata handler will run start() */
      }
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          setNeedsTap(false);
          setAudioError(false);
        }).catch(() => setNeedsTap(true));
      }
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => el.pause(), 10000); // stop after 10s
    };
    startRef.current = start;

    // If the clip fails to load/decode, surface a retry control.
    const onError = () => setAudioError(true);
    el.addEventListener("error", onError);

    if (el.readyState >= 1) start(); // metadata already available -> seek now
    else el.addEventListener("loadedmetadata", start, { once: true });

    return () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      el.removeEventListener("loadedmetadata", start);
      el.removeEventListener("error", onError);
      el.pause();
    };
  }, [state.audioUrl]);

  // Manual recovery from an audio load/decode failure.
  const retryAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    setAudioError(false);
    el.load();
    el.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
  };

  const seconds = useCountdown(state.timeRemainingMs, state.round);

  // Round value banner. Prefer the server's roundStart values (roundMeta);
  // fall back to the derived formula only if that event hasn't arrived yet.
  const questionValue =
    roundMeta?.questionValue ?? QUESTION_BASE + (state.round - 1) * QUESTION_STEP;
  const maxSpeedBonus = roundMeta?.maxSpeedBonus ?? MAX_SPEED_BONUS;

  return (
    <div className="space-y-8">
      {/* hidden audio element; seek + play are driven by the effect via ref */}
      <audio ref={audioRef} src={state.audioUrl} preload="auto" />

      <div className={`${EYEBROW} flex items-center justify-center gap-3 border border-zinc-800 bg-zinc-950 px-4 py-2`}>
        <span>
          Question Value: <span className="text-zinc-200">{questionValue}</span>
        </span>
        <span className="text-zinc-700">|</span>
        <span>
          Speed Bonus: <span className="text-zinc-200">{maxSpeedBonus}</span>
        </span>
      </div>

      <TimeCounter seconds={seconds} />

      {audioError && (
        <button
          onClick={retryAudio}
          className="w-full border border-amber-400 px-5 py-3 font-mono text-sm uppercase tracking-[0.2em] text-amber-300 transition-colors hover:bg-amber-400 hover:text-black"
        >
          Audio failed — tap to retry
        </button>
      )}

      {needsTap && (
        <button onClick={() => startRef.current()} className={`${BTN} w-full`}>
          ▶ Tap to play clip
        </button>
      )}

      <div className="grid gap-3">
        {state.options.map((opt) => {
          const selected = myGuess === opt;
          return (
            <button
              key={opt}
              onClick={() => onGuess(opt)}
              disabled={hasGuessed}
              className={[
                "w-full border px-5 py-4 text-left font-mono text-sm uppercase tracking-wide transition-colors",
                selected
                  ? "border-zinc-100 bg-zinc-900 text-zinc-100"
                  : "border-zinc-700 bg-zinc-800 text-white enabled:hover:bg-white enabled:hover:text-zinc-900",
                "disabled:cursor-not-allowed disabled:opacity-50",
              ].join(" ")}
            >
              {opt}
            </button>
          );
        })}
      </div>

      <p className={`${EYEBROW} text-center`}>
        {hasGuessed ? "Locked in — hold tight." : "Pick the track. Faster = more points."}
      </p>
    </div>
  );
}

// ---------- Reveal ----------
function Reveal({ reveal, myId }) {
  const results = reveal?.results ?? [];
  const winner = reveal?.roundWinner ?? null; // fastest correct answer, or null
  const round = reveal?.round ?? 0;
  const leaderboard =
    reveal?.leaderboard ??
    [...results].sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, ...p }));
  // roundWinner carries name + time; pull their points from the results list.
  const winnerResult = winner ? results.find((r) => r.name === winner.name) : null;
  const winnerPoints = winnerResult?.pointsEarned ?? 0;
  const winnerStreak = winnerResult?.streakBonus ?? 0;

  return (
    <div className="space-y-6">
      <p className={EYEBROW}>Round {String(round).padStart(2, "0")} / 10</p>

      {/* Winner card: left green accent, big points */}
      {winner ? (
        <div className="border border-zinc-600 border-l-4 border-l-green-400 bg-zinc-950 px-5 py-5">
          <p className={`${EYEBROW} text-green-400`}>Fastest this round</p>
          <div className="mt-3 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-2xl font-black uppercase tracking-tighter text-zinc-100">
                {winner.name}
              </p>
              <p className="mt-1 font-mono text-xs tabular-nums text-zinc-500">{winner.answerTimeSeconds}s</p>
            </div>
            <p className="shrink-0 font-mono text-3xl font-bold tabular-nums text-green-400">+{winnerPoints}</p>
          </div>
          {winnerStreak > 0 && (
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-amber-400">
              🔥 streak +{winnerStreak}
            </p>
          )}
        </div>
      ) : (
        <div className="border border-zinc-700 bg-zinc-950 px-5 py-6 text-center">
          <p className="text-2xl font-black uppercase tracking-tighter text-zinc-500">No one got it</p>
        </div>
      )}

      {/* Per-player results: name | answer time | correct/wrong | points */}
      <div>
        <p className={EYEBROW}>This round</p>
        <ul className={`mt-3 ${PANEL} divide-y divide-zinc-900`}>
          {results.map((r) => {
            const answered = r.answerTimeSeconds != null;
            const isMe = myId && r.id === myId;
            return (
              <li
                key={r.id ?? r.name}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${isMe ? "bg-zinc-900/60" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <StatusDot correct={r.correct} answered={answered} />
                  <span className="truncate font-mono uppercase tracking-wide">{r.name}</span>
                  {r.streakBonus > 0 && (
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-amber-400">
                      🔥{r.currentStreak}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-4 font-mono text-sm tabular-nums">
                  <span className="text-zinc-500">{answered ? `${r.answerTimeSeconds}s` : "—"}</span>
                  <span className={r.correct ? "text-green-400" : "text-zinc-600"}>+{r.pointsEarned}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Cumulative leaderboard */}
      <Leaderboard rows={leaderboard} myId={myId} title="Leaderboard" />
    </div>
  );
}

// Correct / wrong / no-answer marker for the reveal list.
function StatusDot({ correct, answered }) {
  const cls = !answered ? "text-zinc-700" : correct ? "text-green-400" : "text-red-500";
  const mark = !answered ? "○" : correct ? "✓" : "✗";
  return (
    <span className={`w-4 text-center font-mono text-sm ${cls}`} aria-hidden="true">
      {mark}
    </span>
  );
}

// ---------- Game Over ----------
function GameOver({ gameOver, players, onRestart }) {
  // Prefer the server's final leaderboard; fall back to the last state snapshot.
  const rows =
    gameOver?.leaderboard ??
    [...players].sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, ...p }));
  const champ = rows[0];
  const rest = rows.slice(1);
  const history = gameOver?.roundHistory ?? null;

  return (
    <div className="space-y-8">
      <p className={`${EYEBROW} text-center`}>That's a wrap</p>

      {/* Champion card */}
      {champ && (
        <div className="border border-zinc-500 bg-zinc-950 px-6 py-6 text-center">
          <p className={`${EYEBROW} text-amber-400`}>Champion</p>
          <p className="mt-2 text-2xl font-black uppercase tracking-tighter text-zinc-100">{champ.name}</p>
          <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-white">{champ.score}</p>
        </div>
      )}

      {rest.length > 0 && (
        <div>
          <p className={EYEBROW}>Final scores</p>
          <ol className={`mt-3 ${PANEL} divide-y divide-zinc-900`}>
            {rest.map((r, i) => (
              <li key={r.id ?? r.name ?? i} className="flex items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-3">
                  <span className="w-6 font-mono text-xs text-zinc-600">{String(r.rank ?? i + 2).padStart(2, "0")}</span>
                  <span className="font-mono text-sm uppercase tracking-wide text-zinc-400">{r.name}</span>
                </span>
                <span className="font-mono text-sm tabular-nums text-zinc-400">{r.score}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {history && history.length > 0 && <RoundHistory history={history} />}

      <button
        onClick={onRestart}
        className="w-full bg-white px-5 py-4 font-mono text-base uppercase tracking-[0.2em] text-black transition-colors hover:bg-zinc-200"
      >
        ↻ Play again
      </button>
    </div>
  );
}

// Collapsible per-round recap shown on game over (Feature 6).
function RoundHistory({ history }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${EYEBROW} flex w-full items-center gap-2 text-left hover:text-zinc-300`}
      >
        <span>{open ? "▼" : "▶"}</span> See all rounds
      </button>
      {open && (
        <ol className={`mt-3 ${PANEL} divide-y divide-zinc-900`}>
          {history.map((h, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 font-mono text-xs">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-6 text-zinc-600">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate text-zinc-600">
                  <span className="text-zinc-400">{h.artistName}</span> — {h.trackName}
                </span>
              </span>
              <span className="shrink-0 uppercase tracking-wide text-zinc-200">{h.winner || "No one"}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------- Reusable bits ----------
function Leaderboard({ rows, myId, title }) {
  return (
    <div>
      {title && <p className={EYEBROW}>{title}</p>}
      <ol className={`mt-3 ${PANEL} divide-y divide-zinc-900`}>
        {rows.map((r, i) => {
          const isMe = myId && r.id === myId;
          const top = i === 0;
          return (
            <li
              key={r.id ?? r.name ?? i}
              className={`flex items-center justify-between px-4 py-3 ${isMe ? "bg-zinc-900/60" : ""}`}
            >
              <span className="flex items-center gap-3">
                <span className="w-6 font-mono text-xs text-zinc-600">{String(r.rank ?? i + 1).padStart(2, "0")}</span>
                <span className={`font-mono uppercase tracking-wide ${top ? "text-white" : "text-zinc-400"}`}>{r.name}</span>
              </span>
              <span className={`font-mono tabular-nums ${top ? "text-white" : "text-zinc-400"}`}>{r.score}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TimeCounter({ seconds }) {
  const total = 10; // server round length; bar is display-only
  const pct = Math.max(0, Math.min(100, (seconds / total) * 100));
  const low = seconds <= 3; // the only place red appears outside reveal
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div>
      <div className="flex items-end justify-between">
        <span className={EYEBROW}>Time</span>
        <span
          className={`font-mono text-6xl font-bold tabular-nums leading-none ${
            low ? "text-red-400" : "text-zinc-100"
          }`}
        >
          {mm}:{ss}
        </span>
      </div>
      <div className="mt-3 h-1 w-full bg-zinc-900">
        <div
          className={`h-full transition-all duration-1000 ease-linear ${low ? "bg-red-500" : "bg-zinc-100"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
      {children}
    </span>
  );
}

function Centered({ eyebrow, title }) {
  return (
    <div className="text-center">
      <p className={EYEBROW}>{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-black uppercase tracking-tighter">{title}</h2>
    </div>
  );
}

function ErrorBar({ message }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 border-b border-rose-500 bg-rose-500/10 px-5 py-3 text-center font-mono text-xs uppercase tracking-[0.2em] text-rose-300 backdrop-blur"
    >
      {message}
    </div>
  );
}

function LoadingOverlay({ message }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/95">
      <div className="h-12 w-12 animate-spin rounded-full border-2 border-zinc-800 border-t-zinc-100" />
      <p className={EYEBROW}>{message}</p>
    </div>
  );
}

// ---------- Display-only countdown ----------
// Seeds from the server's timeRemainingMs at the start of each round and ticks
// down locally for smooth display. The server is still the only authority on
// scoring — this number never leaves the client.
function useCountdown(timeRemainingMs, round) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const endAt = Date.now() + (timeRemainingMs ?? 0);
    const tick = () => setSeconds(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
    // Re-seed only when the round changes, so mid-round state updates don't
    // jitter the visible countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);
  return seconds;
}
