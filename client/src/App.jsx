// App — React client for the multiplayer music guessing game.
//
// Design: "minimalist arcade" — bone on void, one amber CRT phosphor accent,
// Space Mono scoreboard, hairline rules, zero radius. The signature is the CRT
// timer/score. Green/red appear ONLY on reveal to mark answers (+ glyphs).
//
// IMPORTANT: this file is presentation only. The socket/data contract is
// untouched — every prop, event, and server field is wired exactly as before.

import { useCallback, useEffect, useRef, useState } from "react";
import { useGameSocket } from "./useGameSocket";

// ---- Shared class fragments (drive the look across every screen) ----
const EYEBROW = "font-console text-[11px] uppercase tracking-[0.2em] text-dim";
const PANEL = "border border-rule bg-cabinet";
// Primary CTA = pink with a soft neon glow.
const BTN_AMBER =
  "bg-pink px-5 py-4 font-console text-sm uppercase tracking-[0.2em] text-black " +
  "shadow-[0_0_24px_-6px_#FF3D7F] transition-[transform,background-color] hover:bg-[#ff5e96] active:scale-[.98] " +
  "focus:outline-none focus:ring-2 focus:ring-pink focus:ring-offset-2 focus:ring-offset-void " +
  "disabled:cursor-not-allowed disabled:bg-rule disabled:text-dim disabled:shadow-none";
const BTN_GHOST =
  "border border-rule bg-cabinet px-5 py-3 font-console text-sm uppercase tracking-[0.2em] text-bone " +
  "transition-colors hover:border-amber hover:text-amber active:scale-[.98] " +
  "focus:outline-none focus:ring-2 focus:ring-amber disabled:cursor-not-allowed disabled:opacity-50";

// Fallback scoring constants, mirroring server.js (banner uses roundMeta first).
const QUESTION_BASE = 300;
const QUESTION_STEP = 250;
const MAX_SPEED_BONUS = 350;

// Genre options the host can pick before starting (Feature 1).
const GENRES = ["HIP-HOP", "R&B", "RAP", "DRILL", "TRAP"];

// Reaction call-outs (must match the server's REACTIONS whitelist). Typographic,
// not emoji — keeps the §12 design rule while still being expressive.
const REACTION_TOKENS = ["GG", "WOW", "!!", "??", "★", "♥"];

// Host-configurable match settings. Each option is { label, value } and the
// value is sent to the server, which re-validates against its own allowlist.
const ROUND_OPTS = [
  { label: "10", value: 10 },
  { label: "5", value: 5 },
  { label: "15", value: 15 },
];
const TIMER_OPTS = [
  { label: "10s", value: 10000 },
  { label: "7.5s", value: 7500 },
  { label: "15s", value: 15000 },
];
const OPTION_OPTS = [
  { label: "4", value: 4 },
  { label: "3", value: 3 },
  { label: "6", value: 6 },
];
const MODE_OPTS = [
  { label: "Title", value: "TITLE" },
  { label: "Artist", value: "ARTIST" },
];
const DECADE_OPTS = [
  { label: "All", value: "all" },
  { label: "2020s", value: "2020s" },
  { label: "2010s", value: "2010s" },
  { label: "2000s", value: "2000s" },
  { label: "90s", value: "1990s" },
];

// Each option slot (1-4) gets its own arcade-button color. Full literal class
// strings so Tailwind's JIT picks them up.
const OPT_COLORS = [
  { num: "text-cyan", sel: "border-cyan bg-cyan/10 ring-cyan", hov: "enabled:hover:border-cyan enabled:hover:bg-cyan/10" },
  { num: "text-pink", sel: "border-pink bg-pink/10 ring-pink", hov: "enabled:hover:border-pink enabled:hover:bg-pink/10" },
  { num: "text-good", sel: "border-good bg-good/10 ring-good", hov: "enabled:hover:border-good enabled:hover:bg-good/10" },
  { num: "text-yellow", sel: "border-yellow bg-yellow/10 ring-yellow", hov: "enabled:hover:border-yellow enabled:hover:bg-yellow/10" },
];

export default function App() {
  const {
    connected, myId, state, reveal, gameOver, loading, error, roundMeta, countdown, notice,
    messages, reactions, roomCode, createRoom, joinRoom, quickPlay, start, guess, restart,
    sendChat, sendReaction, clearError, clearNotice,
  } = useGameSocket();

  // --- Mobile audio unlock (priming) ---------------------------------------
  // One persistent <audio> at the root, primed on the first tap (Enter/Start)
  // so mobile autoplays each round without the tap penalty.
  const audioRef = useRef(null);
  const primedRef = useRef(false);

  const primeAudio = () => {
    if (primedRef.current) return;
    const el = audioRef.current;
    if (!el) return;
    primedRef.current = true;
    try {
      el.src =
        "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA";
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => el.pause()).catch(() => {});
      }
    } catch {
      /* ignore — per-round tap fallback still covers playback */
    }
  };

  const handleCreate = (name, idToken) => {
    primeAudio();
    createRoom(name, idToken);
  };
  const handleJoinRoom = (code, name, idToken) => {
    primeAudio();
    joinRoom(code, name, idToken);
  };
  const handleQuick = (name, idToken) => {
    primeAudio();
    quickPlay(name, idToken);
  };
  const handleStart = (settings) => {
    primeAudio();
    start(settings);
  };

  const phase = state?.phase ?? "LOBBY";
  const players = state?.players ?? [];
  const me = players.find((p) => p.id === myId) || null;
  const joined = Boolean(me);
  const isSpectator = Boolean(me?.spectator);
  // Host = the first non-spectator player (mirrors the server's host rule).
  const firstPlayer = players.find((p) => !p.spectator) || null;
  const isHost = Boolean(firstPlayer && firstPlayer.id === myId);

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

  // Auto-dismiss bottom toasts.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 3000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  const handleGuess = (opt) => {
    setMyGuess(opt);
    guess(opt);
  };

  return (
    <div className="crt-scan min-h-screen bg-void font-console text-bone antialiased selection:bg-amber selection:text-black">
      {error && <ErrorBar message={error} />}
      {loading && <LoadingOverlay message={loading.message} />}
      {countdown && (
        <CountdownOverlay
          key={countdown.round}
          seconds={countdown.seconds}
          round={countdown.round}
          worth={countdown.questionValue}
          maxPoints={countdown.maxPoints}
        />
      )}
      {notice && <Toast message={notice} />}
      <ReactionOverlay reactions={reactions} />

      <div className="mx-auto flex min-h-screen max-w-xl flex-col px-5 pt-6 pb-8">
        <Masthead phase={phase} round={round} total={state?.totalRounds} />

        <main className="flex flex-1 flex-col justify-start py-8">
          {!connected ? (
            <Centered eyebrow="Status" title="Connecting…" />
          ) : !joined ? (
            <EntryScreen onCreate={handleCreate} onJoin={handleJoinRoom} onQuick={handleQuick} />
          ) : phase === "LOBBY" ? (
            <Lobby
              players={players}
              myId={myId}
              isHost={isHost}
              onStart={handleStart}
              code={roomCode}
              messages={messages}
              onChat={sendChat}
            />
          ) : phase === "ROUND_PLAYING" ? (
            <Playing
              state={state}
              roundMeta={roundMeta}
              myGuess={myGuess}
              hasGuessed={Boolean(myGuess) || Boolean(me?.hasGuessed)}
              spectator={isSpectator}
              onGuess={handleGuess}
              onReact={sendReaction}
              audioRef={audioRef}
            />
          ) : phase === "ROUND_REVEAL" ? (
            <Reveal reveal={reveal} myId={myId} onReact={sendReaction} players={players} />
          ) : phase === "GAME_OVER" ? (
            <GameOver
              gameOver={gameOver}
              players={players}
              myId={myId}
              onRestart={restart}
              messages={messages}
              onChat={sendChat}
            />
          ) : null}
        </main>

        <footer className={`${EYEBROW} flex items-center justify-between border-t border-rule pt-4`}>
          <span>{connected ? "● Online" : "○ Offline"}</span>
          <span className="text-bone">{me ? me.name : "Guest"}</span>
        </footer>
      </div>

      {/* Single persistent, primed audio element reused across all rounds. */}
      <audio ref={audioRef} preload="auto" className="hidden" />
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
    <header className="flex items-end justify-between border-b border-rule pb-4">
      <h1 className="flex items-center font-marquee text-2xl font-black uppercase leading-none tracking-tight text-bone sm:text-3xl">
        Snippet
        <span className="ml-1.5 inline-block h-[0.7em] w-[0.32em] animate-blink bg-pink" aria-hidden="true" />
      </h1>
      <span className={EYEBROW}>{label}</span>
    </header>
  );
}

// ---------- Entry: sign in (Google or guest), create or join a room ----------
function EntryScreen({ onCreate, onJoin, onQuick }) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => {
    if (typeof window === "undefined") return "";
    return (new URLSearchParams(window.location.search).get("room") || "").toUpperCase().slice(0, 4);
  });
  const [googleCred, setGoogleCred] = useState(null); // { name, idToken }
  const onSignIn = useCallback((c) => setGoogleCred(c), []);

  const identityName = googleCred ? googleCred.name : name.trim();
  const idToken = googleCred ? googleCred.idToken : undefined;
  const canPlay = identityName.length > 0;

  return (
    <div className="mx-auto w-full max-w-sm animate-rise space-y-6">
      <div>
        <p className="font-coin text-base leading-relaxed text-pink">INSERT COIN</p>
        <div className="mt-3 h-px w-24 bg-rule" />
        <p className="mt-4 font-console text-sm text-dim">
          Sign in or play as a guest, then create or join a room.
        </p>
      </div>

      {clientId &&
        (googleCred ? (
          <div className={`${PANEL} flex items-center justify-between px-4 py-3`}>
            <span className="min-w-0 truncate font-console text-sm text-bone">
              Signed in · <span className="text-good">{googleCred.name}</span>
            </span>
            <button
              onClick={() => setGoogleCred(null)}
              className="shrink-0 font-console text-xs uppercase tracking-[0.2em] text-dim hover:text-pink"
            >
              Switch
            </button>
          </div>
        ) : (
          <GoogleSignIn clientId={clientId} onSignIn={onSignIn} />
        ))}

      {!googleCred && (
        <div>
          {clientId && <p className={`${EYEBROW} mb-2`}>or play as guest</p>}
          <div className="flex items-center border-b-2 border-rule focus-within:border-pink">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="YOUR HANDLE"
              aria-label="Your handle"
              className="w-full bg-transparent px-1 py-3 font-console text-lg uppercase tracking-widest text-bone placeholder:text-dim focus:outline-none"
            />
            {name.length === 0 && <span className="mr-1 h-5 w-2 animate-blink bg-pink" aria-hidden="true" />}
          </div>
        </div>
      )}

      <button
        onClick={() => canPlay && onCreate(identityName, idToken)}
        disabled={!canPlay}
        className={`${BTN_AMBER} w-full`}
      >
        ▶ Create Room
      </button>

      <button
        onClick={() => canPlay && onQuick(identityName, idToken)}
        disabled={!canPlay}
        className={`${BTN_GHOST} w-full`}
      >
        ▶ Quick Play · public match
      </button>

      <div>
        <p className={EYEBROW}>or join with a code</p>
        <div className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
            maxLength={4}
            placeholder="CODE"
            aria-label="Room code"
            className="w-28 border border-rule bg-cabinet px-3 py-3 text-center font-console text-lg uppercase tracking-[0.3em] text-bone placeholder:text-dim focus:border-pink focus:outline-none"
          />
          <button
            onClick={() => canPlay && code && onJoin(code, identityName, idToken)}
            disabled={!canPlay || !code}
            className={`${BTN_GHOST} flex-1`}
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}

// Google Identity Services button. Renders nothing if no client ID is set (then
// the app is guest-only). The credential is a Google ID token the server
// re-verifies — the client never trusts it for identity.
function GoogleSignIn({ clientId, onSignIn }) {
  const ref = useRef(null);
  const cbRef = useRef(onSignIn);
  cbRef.current = onSignIn;
  useEffect(() => {
    if (!clientId) return;
    let timer = null;
    const init = () => {
      const g = window.google && window.google.accounts && window.google.accounts.id;
      if (!g || !ref.current) return false;
      g.initialize({
        client_id: clientId,
        callback: (resp) => {
          try {
            const part = resp.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            const payload = JSON.parse(decodeURIComponent(escape(atob(part))));
            cbRef.current({ name: payload.name || payload.email, idToken: resp.credential });
          } catch {
            /* ignore malformed token */
          }
        },
      });
      ref.current.innerHTML = "";
      g.renderButton(ref.current, { theme: "filled_black", size: "large", text: "signin_with", shape: "rectangular" });
      return true;
    };
    if (!init()) timer = setInterval(() => { if (init()) clearInterval(timer); }, 200);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [clientId]);
  if (!clientId) return null;
  return <div ref={ref} className="flex justify-center" />;
}

// ---------- Lobby ----------
function Lobby({ players, myId, isHost, onStart, code, messages, onChat }) {
  const [copied, setCopied] = useState(false);
  const [genre, setGenre] = useState("HIP-HOP");
  // Match settings (host only). Defaults mirror the server's DEFAULT_SETTINGS.
  const [settings, setSettings] = useState({
    rounds: 10,
    roundMs: 10000,
    optionsCount: 4,
    mode: "TITLE",
    decade: "all",
  });
  const setField = (key) => (value) => setSettings((s) => ({ ...s, [key]: value }));
  const handleStart = () => onStart({ ...settings, genre: genre.toLowerCase() });
  const joinLink =
    typeof window !== "undefined" && code ? `${window.location.origin}?room=${code}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <p className={EYEBROW}>Players {String(players.length).padStart(2, "0")} / 08</p>
        <ul className={`mt-3 ${PANEL} divide-y divide-rule`}>
          {players.map((p, i) => (
            <li
              key={p.id}
              className={`flex items-center justify-between px-4 py-3 ${i % 2 ? "bg-void/40" : ""}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={p.name} src={p.avatar} />
                <span className="font-console text-xs text-cyan">{i + 1}UP</span>
                <span className="truncate font-console uppercase tracking-wide text-bone">{p.name}</span>
                {p.google && (
                  <span className="shrink-0 text-good" title="Google verified" aria-label="verified">
                    ✓
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3 font-console text-[10px] uppercase tracking-[0.2em]">
                {p.id === myId && <span className="text-dim">· You</span>}
                {i === 0 && <span className="text-amber">[Host]</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className={EYEBROW}>Room code</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-marquee text-4xl font-black tracking-[0.25em] text-amber">{code}</span>
          <button onClick={copy} className={BTN_GHOST}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
        <p className="mt-2 font-console text-xs text-dim">Friends join with this code, or your copied link.</p>
      </div>

      {isHost ? (
        <div className="space-y-5">
          <div>
            <p className={EYEBROW}>Genre</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {GENRES.map((g) => {
                const active = g === genre;
                return (
                  <button
                    key={g}
                    onClick={() => setGenre(g)}
                    className={`px-3 py-2 font-console text-xs uppercase tracking-[0.2em] transition-colors ${
                      active
                        ? "bg-pink text-black"
                        : "border border-rule text-dim hover:border-pink hover:text-pink"
                    }`}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          </div>

          <SettingRow label="Mode" options={MODE_OPTS} value={settings.mode} onChange={setField("mode")} />
          <SettingRow label="Rounds" options={ROUND_OPTS} value={settings.rounds} onChange={setField("rounds")} />
          <SettingRow label="Timer" options={TIMER_OPTS} value={settings.roundMs} onChange={setField("roundMs")} />
          <SettingRow label="Answers" options={OPTION_OPTS} value={settings.optionsCount} onChange={setField("optionsCount")} />
          <SettingRow label="Era" options={DECADE_OPTS} value={settings.decade} onChange={setField("decade")} />

          <button onClick={handleStart} className={`${BTN_AMBER} w-full`}>
            ▶ Start Game
          </button>
        </div>
      ) : (
        <p className={`${EYEBROW} text-center`}>
          <span className="animate-blink text-amber">▍</span> Waiting for host
        </p>
      )}

      <Chat messages={messages} onChat={onChat} myId={myId} title="Lobby chat" />
    </div>
  );
}

// A labelled segmented control for one match setting (host lobby).
function SettingRow({ label, options, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className={EYEBROW}>{label}</p>
      <div className="flex flex-wrap justify-end gap-1.5">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={String(o.value)}
              onClick={() => onChange(o.value)}
              aria-pressed={active}
              className={`min-w-[2.75rem] px-2.5 py-1.5 font-console text-xs uppercase tracking-[0.12em] transition-colors ${
                active
                  ? "bg-pink text-black"
                  : "border border-rule text-dim hover:border-pink hover:text-pink"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Playing ----------
function Playing({ state, roundMeta, myGuess, hasGuessed, spectator, onGuess, onReact, audioRef }) {
  const locked = hasGuessed || spectator; // spectators can't answer
  const startRef = useRef(() => {});
  const [needsTap, setNeedsTap] = useState(false);
  const [audioError, setAudioError] = useState(false);

  // Play a 10-second snippet from a random offset that always leaves room.
  // Drives the persistent, primed root <audio> element via audioRef.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    let pauseTimer = null;

    // Point the primed, persistent element at this round's clip. Pause first to
    // avoid an "interrupted by load()" abort if a previous play is still pending.
    el.pause();
    el.src = state.audioUrl;
    el.load();

    const start = () => {
      try {
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

    const onError = () => setAudioError(true);
    el.addEventListener("error", onError);

    if (el.readyState >= 1) start();
    else el.addEventListener("loadedmetadata", start, { once: true });

    return () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      el.removeEventListener("loadedmetadata", start);
      el.removeEventListener("error", onError);
      el.pause();
    };
  }, [state.audioUrl, audioRef]);

  // Manual recovery from an audio load/decode failure.
  const retryAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    setAudioError(false);
    el.load();
    el.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
  };

  // Arcade keys 1-4 to answer (also an a11y win). Guard once-guessed/spectator.
  useEffect(() => {
    if (locked) return;
    const onKey = (e) => {
      const i = parseInt(e.key, 10);
      if (i >= 1 && i <= (state.options?.length ?? 0)) onGuess(state.options[i - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, state.options, onGuess]);

  const seconds = useCountdown(state.timeRemainingMs, state.round);

  // Round value chip. Prefer the server's roundStart values (roundMeta).
  const questionValue =
    roundMeta?.questionValue ?? QUESTION_BASE + (state.round - 1) * QUESTION_STEP;
  const maxSpeedBonus = roundMeta?.maxSpeedBonus ?? MAX_SPEED_BONUS;
  const isArtist = state.mode === "ARTIST";
  const roundSeconds = Math.round((state.roundMs ?? 10000) / 1000);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <span className={EYEBROW}>{isArtist ? "Name the artist" : "Name the track"}</span>
        <span className="font-console text-xs uppercase tracking-[0.18em] text-dim">
          QV <span className="text-amber">{questionValue}</span> · Speed ≤{maxSpeedBonus}
        </span>
      </div>

      <TimeCounter seconds={seconds} total={roundSeconds} />

      {audioError && (
        <button
          onClick={retryAudio}
          className="w-full border border-amber px-5 py-3 font-console text-sm uppercase tracking-[0.2em] text-amber transition-colors hover:bg-amber hover:text-black"
        >
          Audio failed — tap to retry
        </button>
      )}

      {needsTap && (
        <button onClick={() => startRef.current()} className={`${BTN_GHOST} w-full`}>
          ▶ Tap to play clip
        </button>
      )}

      <div className="grid gap-3">
        {state.options.map((opt, i) => {
          const selected = myGuess === opt;
          const dimmed = locked && !selected; // lock animation
          const c = OPT_COLORS[i % OPT_COLORS.length];
          return (
            <div key={opt}>
              <button
                onClick={() => onGuess(opt)}
                disabled={locked}
                className={[
                  "flex w-full items-center gap-4 border px-4 py-4 text-left font-console text-sm uppercase tracking-wide text-bone transition-all",
                  selected ? `ring-2 ${c.sel}` : `border-rule bg-cabinet ${c.hov}`,
                  dimmed ? "pointer-events-none opacity-30" : "",
                  "disabled:cursor-not-allowed",
                ].join(" ")}
              >
                <span className={`font-console text-xs ${c.num}`}>{i + 1}</span>
                <span className="min-w-0 truncate">{opt}</span>
              </button>
              {hasGuessed && selected && (
                <p className={`mt-1 font-console text-xs uppercase tracking-[0.2em] ${c.num}`}>Locked</p>
              )}
            </div>
          );
        })}
      </div>

      {spectator ? (
        <p className={`${EYEBROW} text-center text-cyan`}>Spectating — you can watch and react, but not guess</p>
      ) : (
        !hasGuessed && (
          <p className={`${EYEBROW} text-center`}>
            {isArtist ? "Pick the artist" : "Pick the track"} — faster = more points · keys 1-
            {state.options.length}
          </p>
        )
      )}

      <ReactionBar onReact={onReact} />
    </div>
  );
}

// ---------- Reveal ----------
function Reveal({ reveal, myId, onReact, players }) {
  const results = reveal?.results ?? [];
  const winner = reveal?.roundWinner ?? null; // fastest correct answer, or null
  const round = reveal?.round ?? 0;
  const avatarOf = {};
  for (const p of players ?? []) avatarOf[p.id] = p.avatar;
  const total = reveal?.totalRounds ?? 10;
  const track = reveal?.track ?? null; // { trackName, artistName } — always shown
  const isArtist = reveal?.mode === "ARTIST";
  const leaderboard =
    reveal?.leaderboard ??
    [...results].sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, ...p }));
  const winnerResult = winner ? results.find((r) => r.name === winner.name) : null;
  const winnerPoints = winnerResult?.pointsEarned ?? 0;
  const winnerStreak = winnerResult?.streakBonus ?? 0;

  return (
    <div className="space-y-6">
      <p className={EYEBROW}>
        Round {String(round).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </p>

      {track && (
        <div className={`${PANEL} px-5 py-4`}>
          <p className={EYEBROW}>The answer</p>
          <p className="mt-2 font-marquee text-lg font-black uppercase tracking-tight text-bone">
            <span className={isArtist ? "text-amber" : ""}>{track.artistName}</span>
            <span className="text-dim"> — </span>
            <span className={isArtist ? "" : "text-amber"}>{track.trackName}</span>
          </p>
        </div>
      )}

      {/* Winner card: HIGH SCORE, amber left accent, big points */}
      {winner ? (
        <div className="border border-amber/40 border-l-4 border-l-amber bg-amber/5 px-5 py-5 shadow-[0_0_30px_-10px_#FFC93C]">
          <p className="font-coin text-xs text-amber">HIGH SCORE</p>
          <div className="mt-3 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate font-marquee text-2xl font-black uppercase tracking-tight text-bone">
                {winner.name}
              </p>
              <p className="mt-1 font-console text-xs tabular-nums text-dim">{winner.answerTimeSeconds}s</p>
            </div>
            <p className="shrink-0 animate-scoreroll font-marquee text-3xl font-black tabular-nums text-amber">
              +{winnerPoints}
            </p>
          </div>
          {winnerStreak > 0 && (
            <p className="mt-2 font-console text-[11px] uppercase tracking-[0.2em] text-amber">
              Streak +{winnerStreak}
            </p>
          )}
        </div>
      ) : (
        <div className="border border-bad/50 bg-bad/5 px-5 py-6 text-center shadow-[0_0_30px_-10px_#FF4D6D]">
          <p className="font-marquee text-2xl font-black uppercase tracking-tight text-bad">No one got it</p>
        </div>
      )}

      {/* Per-player results: name | answer time | correct/wrong | points */}
      <div>
        <p className={EYEBROW}>This round</p>
        <ul className={`mt-3 ${PANEL} divide-y divide-rule`}>
          {results.map((r) => {
            const answered = r.answerTimeSeconds != null;
            const isMe = myId && r.id === myId;
            return (
              <li
                key={r.id ?? r.name}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${
                  r.correct ? "bg-good/5" : isMe ? "bg-pink/5" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <StatusDot correct={r.correct} answered={answered} />
                  <Avatar name={r.name} src={avatarOf[r.id]} size={22} />
                  <span className="truncate font-console uppercase tracking-wide text-bone">{r.name}</span>
                  {r.streakBonus > 0 && (
                    <span className="shrink-0 font-console text-[10px] uppercase tracking-wide text-amber">
                      +{r.currentStreak} st
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-4 font-console text-sm tabular-nums">
                  <span className="text-dim">{answered ? `${r.answerTimeSeconds}s` : "—"}</span>
                  <span className={r.correct ? "text-good" : "text-dim"}>+{r.pointsEarned}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <Leaderboard rows={leaderboard} myId={myId} title="Leaderboard" />

      <ReactionBar onReact={onReact} />
    </div>
  );
}

// Correct / wrong / no-answer marker for the reveal list.
function StatusDot({ correct, answered }) {
  const cls = !answered ? "text-dim" : correct ? "text-good" : "text-bad";
  const mark = !answered ? "○" : correct ? "✓" : "✗";
  return (
    <span className={`w-4 text-center font-console text-sm ${cls}`} aria-hidden="true">
      {mark}
    </span>
  );
}

// ---------- Game Over ----------
function GameOver({ gameOver, players, myId, onRestart, messages, onChat }) {
  const rows =
    gameOver?.leaderboard ??
    [...players].sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, ...p }));
  const champ = rows[0];
  const rest = rows.slice(1);
  const history = gameOver?.roundHistory ?? null;
  const avatarOf = {};
  for (const p of players ?? []) avatarOf[p.id] = p.avatar;

  return (
    <div className="space-y-8">
      <p className="text-center font-marquee text-4xl font-black uppercase tracking-tight text-bone">
        Game Over
      </p>

      {champ && (
        <div className="border border-amber/50 bg-amber/5 px-6 py-6 text-center shadow-[0_0_36px_-12px_#FFC93C]">
          <p className="font-coin text-xs text-amber">1UP · Champion</p>
          <div className="mt-3 flex items-center justify-center gap-3">
            <Avatar name={champ.name} src={avatarOf[champ.id]} size={32} />
            <p className="font-console uppercase tracking-wide text-bone">{champ.name}</p>
          </div>
          <p className="mt-1 animate-scoreroll font-marquee text-4xl font-black tabular-nums text-amber">
            {champ.score}
          </p>
        </div>
      )}

      {rest.length > 0 && (
        <div>
          <p className={EYEBROW}>High scores</p>
          <ol className={`mt-3 ${PANEL} divide-y divide-rule`}>
            {rest.map((r, i) => (
              <li key={r.id ?? r.name ?? i} className="flex items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-3">
                  <span className="w-6 font-console text-xs text-dim">{String(r.rank ?? i + 2).padStart(2, "0")}</span>
                  <span className="font-console text-sm uppercase tracking-wide text-dim">{r.name}</span>
                </span>
                <span className="font-console text-sm tabular-nums text-dim">{r.score}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {history && history.length > 0 && <RoundHistory history={history} />}

      <Chat messages={messages} onChat={onChat} myId={myId} title="Chat" />

      <button onClick={onRestart} className={`${BTN_AMBER} w-full`}>
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
        className={`${EYEBROW} flex w-full items-center gap-2 text-left hover:text-amber`}
      >
        <span className="text-amber">{open ? "▼" : "▶"}</span> See all rounds
      </button>
      {open && (
        <ol className={`mt-3 ${PANEL} divide-y divide-rule`}>
          {history.map((h, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 font-console text-xs">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-6 text-dim">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate text-dim">
                  <span className="text-bone">{h.artistName}</span> — {h.trackName}
                </span>
              </span>
              <span className="shrink-0 uppercase tracking-wide text-amber">{h.winner || "No one"}</span>
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
      <ol className={`mt-3 ${PANEL} divide-y divide-rule`}>
        {rows.map((r, i) => {
          const isMe = myId && r.id === myId;
          const top = i === 0;
          return (
            <li
              key={r.id ?? r.name ?? i}
              className={`flex items-center justify-between px-4 py-3 ${isMe ? "bg-pink/5" : ""}`}
            >
              <span className="flex items-center gap-3">
                <span className={`w-6 font-console text-xs ${top ? "text-amber" : "text-dim"}`}>
                  {String(r.rank ?? i + 1).padStart(2, "0")}
                </span>
                <span className={`font-console uppercase tracking-wide ${top ? "text-bone" : "text-dim"}`}>
                  {r.name}
                </span>
              </span>
              <span className={`font-console tabular-nums ${top ? "text-amber" : "text-dim"}`}>{r.score}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Square arcade-portrait avatar (zero radius, per the design rules). Falls back
// to the player's initial when there's no Google photo or it fails to load.
function Avatar({ name, src, size = 26 }) {
  const [broken, setBroken] = useState(false);
  const initial = ((name || "?").trim().charAt(0) || "?").toUpperCase();
  const px = `${size}px`;
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: px, height: px }}
        className="shrink-0 border border-rule object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: px, height: px }}
      className="grid shrink-0 place-items-center border border-rule bg-void font-console text-[10px] text-dim"
    >
      {initial}
    </span>
  );
}

// Room chat — used in the lobby and on game over. Rate-limited + masked server
// side; the client just renders.
function Chat({ messages, onChat, myId, title = "Chat" }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onChat(t);
    setText("");
  };
  return (
    <div>
      <p className={EYEBROW}>{title}</p>
      <div className={`mt-3 ${PANEL}`}>
        <div ref={listRef} className="max-h-40 space-y-1.5 overflow-y-auto px-4 py-3" aria-live="polite">
          {messages.length === 0 ? (
            <p className="font-console text-xs text-dim">No messages yet. Say hi.</p>
          ) : (
            messages.map((m) => (
              <p key={m.key} className="font-console text-xs leading-snug">
                <span className={m.id === myId ? "text-pink" : "text-cyan"}>{m.name}</span>
                <span className="text-dim"> · </span>
                <span className="break-words text-bone">{m.text}</span>
              </p>
            ))
          )}
        </div>
        <form onSubmit={submit} className="flex border-t border-rule">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            placeholder="Message…"
            aria-label="Chat message"
            className="w-full bg-transparent px-4 py-2.5 font-console text-xs text-bone placeholder:text-dim focus:outline-none"
          />
          <button
            type="submit"
            className="border-l border-rule px-4 font-console text-xs uppercase tracking-[0.2em] text-dim transition-colors hover:text-pink"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

// The 6 reaction call-outs. Tapping floats one over everyone's screen.
function ReactionBar({ onReact }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {REACTION_TOKENS.map((t) => (
        <button
          key={t}
          onClick={() => onReact(t)}
          aria-label={`React ${t}`}
          className="min-w-[2.5rem] border border-rule bg-cabinet px-2 py-1.5 font-console text-xs text-dim transition-[transform,color,border-color] hover:border-amber hover:text-amber active:scale-95"
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// Full-screen, non-interactive layer that floats incoming reactions upward.
function ReactionOverlay({ reactions }) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[55] overflow-hidden">
      {reactions.map((r) => (
        <div
          key={r.key}
          className="absolute bottom-24 animate-floatup whitespace-nowrap font-marquee text-3xl font-black text-amber phosphor"
          style={{ left: `${12 + (r.lane ?? 0) * 18}%` }}
        >
          {r.token}
          <span className="ml-1 align-middle font-console text-[10px] uppercase tracking-wide text-dim">
            {r.name}
          </span>
        </div>
      ))}
    </div>
  );
}

// The CRT scoreboard — the design signature.
function TimeCounter({ seconds, total = 10 }) {
  const pct = Math.max(0, Math.min(100, (seconds / total) * 100));
  const low = seconds <= 3; // the only place red appears outside reveal
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="bezel border border-rule bg-cabinet px-4 py-5">
      <div className="flex items-center justify-between">
        <span className={EYEBROW}>Time</span>
        <span className={EYEBROW}>{Math.round(pct)}%</span>
      </div>
      <div className="mt-1 text-center">
        <span
          className={`font-console text-7xl font-bold tabular-nums leading-none ${
            low ? "phosphor-bad animate-flicker" : "phosphor"
          }`}
        >
          {mm}:{ss}
        </span>
      </div>
      <div className="mt-4 h-1.5 w-full bg-rule">
        <div
          className={`h-full transition-all duration-1000 ease-linear ${low ? "bg-bad" : "bg-amber"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Centered({ eyebrow, title }) {
  return (
    <div className="text-center">
      <p className={EYEBROW}>{eyebrow}</p>
      <h2 className="mt-2 font-marquee text-3xl font-black uppercase tracking-tight text-bone">{title}</h2>
    </div>
  );
}

function ErrorBar({ message }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 border-b border-bad bg-void/90 px-5 py-3 text-center font-console text-xs uppercase tracking-[0.2em] text-bad backdrop-blur"
    >
      {message}
    </div>
  );
}

// Bottom toast for room notices (player left, new host) — Feature 5.
function Toast({ message }) {
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-rule bg-cabinet px-5 py-3 text-center font-console text-xs uppercase tracking-[0.2em] text-dim"
    >
      {message}
    </div>
  );
}

function LoadingOverlay({ message }) {
  return (
    <div className="crt-scan fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-void/95">
      <p className="font-coin text-xs text-pink">LOADING</p>
      <p className="font-console text-sm uppercase tracking-[0.2em] text-dim">
        {message} <span className="animate-blink text-pink">▍</span>
      </p>
    </div>
  );
}

// 3-2-1-GO overlay shown before each round's audio (Feature 3). Also shows the
// round's point worth + max-if-fastest. Server controls the real 3s gap.
function CountdownOverlay({ seconds, round, worth, maxPoints }) {
  const [n, setN] = useState(seconds ?? 3);
  useEffect(() => {
    let v = seconds ?? 3;
    setN(v);
    const id = setInterval(() => {
      v -= 1;
      setN(v);
      if (v <= -1) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return (
    <div className="crt-scan fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-void/95 px-6 text-center">
      <p className={EYEBROW}>Round {String(round ?? 0).padStart(2, "0")}</p>
      {n > 0 ? (
        <span className="animate-flicker font-marquee text-8xl font-black tabular-nums leading-none phosphor">
          {n}
        </span>
      ) : (
        <span className="font-coin text-5xl leading-none phosphor-pink">GO</span>
      )}
      {worth != null && (
        <div className="space-y-1">
          <p className="font-console text-sm uppercase tracking-[0.2em] text-bone">
            Worth <span className="text-amber">{worth}</span> pts this round
          </p>
          <p className="font-console text-xs uppercase tracking-[0.2em] text-amber">
            Up to {maxPoints} if you answer fastest
          </p>
        </div>
      )}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);
  return seconds;
}
