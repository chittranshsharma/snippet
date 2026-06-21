# Snippet — Project Handoff / Full Context

> Hand this file to a fresh Claude session to continue work. It captures the
> entire project: what it is, how it's built, every contract, the design system,
> deployment, known quirks, hard rules, and future ideas. Nothing important is
> omitted.

---

## 0. TL;DR

**Snippet** is a real-time, multiplayer **music guessing game**. A short (10s)
song snippet plays (iTunes preview); players pick the track from 4 options;
faster correct answers score more. Private **room codes**, **Google or guest**
sign-in, an arcade visual theme.

- **Repo:** `github.com/am1t27/snippet` (branch `main`). Working dir locally:
  `/Users/amitdas/song trivia`.
- **Backend:** Node.js + Socket.IO (`server.js`) + iTunes Search API
  (`itunesFetcher.js`). ESM, **no TypeScript**.
- **Frontend:** React 18 + Vite + Tailwind CSS **v3** (`client/`). No TS, **no
  UI libraries** (Tailwind only).
- **Deploy target:** backend → **Railway** (persistent container), frontend →
  **Vercel** (static). See `DEPLOY.md`. Not yet deployed by the user at handoff.
- A `post-commit` git hook auto-pushes every commit to the repo.

---

## 0.5. Post-handoff changelog — Waves A–E (read this!)

Everything below this section describes the project *as of the original handoff*.
Five feature waves shipped after it (commits `Wave A`…`Wave E`). The hard rules
(§12) and the security contract are all intact and re-verified. What changed:

- **Wave A — host-configurable settings.** Lobby now picks **rounds** (5/10/15),
  **timer** (7.5/10/15s), **answers shown** (3/4/6), **mode** (guess **TITLE** or
  **ARTIST**), and **decade** (all/2020s/2010s/2000s/90s). All validated
  server-side (`sanitizeSettings`). Per-room `room.settings` replaced the
  hardcoded `TOTAL_ROUNDS`/`ROUND_MS`. `reveal` now carries `{track, mode,
  totalRounds}`; `state` carries `roundMs`/`mode`.
- **Wave B — social.** Room **chat** (`chat` event) and **reactions** (`react`
  event, whitelist `GG/WOW/!!/??/★/♥`), both rate-limited; **Google avatars**
  (`avatar` URL in `state.players`; email/sub still server-only); **profanity
  filter** (`profanity.js`) on guest handles + chat; per-socket rate limiter.
- **Wave C — resilience.** **Reconnect/rejoin** via a per-tab token
  (sessionStorage): a mid-game drop **holds the slot 60s**, `rejoin` re-keys the
  socket with score intact; **spectator mode** (join mid-game → watch, can't
  guess, excluded from scoring); **Quick Play** matchmaking (`quickPlay`);
  rematch promotes spectators. New `state.players` fields `spectator`/`connected`.
- **Wave D — feel.** Synthesized **sound** (`sound.js`, Web Audio, no files) with
  a persisted **mute** toggle; **PWA** (`manifest.webmanifest`, `sw.js`,
  `icon.svg`); accessibility (aria-live announcements, button labels).
- **Wave E — quality/infra.** Pure logic extracted to **`gameLogic.js`**;
  **Vitest** suite in `test/` (`npm test`, 23 tests, offline); **CI**
  (`.github/workflows/ci.yml`); structured **`log.js`**; **gated** scale hooks —
  `storage.js` (Postgres global leaderboard, `GET /leaderboard`, needs
  `DATABASE_URL`+`pg`), Redis adapter (`REDIS_URL`), Sentry (`SENTRY_DSN`), all
  dormant unless configured (see DEPLOY.md).

**New client→server events:** `chat`, `react`, `quickPlay`, `rejoin` (+ a
`public` flag on `createRoom`). **New server→client:** `chat`, `reaction`,
`rejoinFailed` (+ `held` on `playerLeft`, `token`/`spectator` on `roomJoined`).
**New modules:** `gameLogic.js`, `profanity.js`, `log.js`, `storage.js`,
`client/src/sound.js`. Scratch smoke tests `_wave{A,B,C}.mjs` are gitignored
(`_*.mjs`); the formal tests live in `test/`.

---

## 1. How to run locally

```bash
# backend (port 3000)
node server.js

# frontend (port 5173), in another terminal
cd client && npm install && npm run dev
# to test on a phone on the same Wi-Fi:
cd client && npm run dev -- --host    # then open http://<your-LAN-IP>:5173
```

- Dev needs **no env vars** — Vite proxies `/socket.io` to `:3000` (see
  `client/vite.config.js`), so the client connects same-origin.
- Open **two browser tabs** (or tabs + phone) to test multiplayer: one creates a
  room, the other joins with the code.
- Health check: `GET http://localhost:3000/` → `{"ok":true,"rooms":N,"players":N}`.

---

## 2. Repository map

```
/ (repo root = BACKEND)
  server.js              Multi-room game server (the engine). ~600 lines.
  itunesFetcher.js       iTunes preview fetcher + artist-diversity sampling + cache.
  package.json           Backend deps: socket.io, node-fetch, google-auth-library.
                         scripts.start = "node server.js". engines.node >= 18.
  package-lock.json
  README.md              Short project readme.
  DEPLOY.md              Step-by-step Railway + Vercel + Google OAuth deploy guide.
  HANDOFF.md             This file.
  .gitignore             node_modules, *.log, .env*, _*.mjs (test scratch), dist.
  .git/hooks/post-commit Auto-pushes `git push origin <branch>` after each commit.

  client/ (FRONTEND)
    index.html           #root, Google Fonts links, Google Identity Services script.
    package.json         react, react-dom, socket.io-client, vite, tailwindcss@^3.4,
                         postcss, autoprefixer, @vitejs/plugin-react.
    vite.config.js       server.port 5173, strictPort, proxy /socket.io -> :3000 (ws:true).
    tailwind.config.js   Color tokens, font families, keyframes/animations.
    postcss.config.js    tailwindcss + autoprefixer.
    vercel.json          SPA rewrite (so /?room=CODE resolves to index.html).
    .env.example         VITE_SOCKET_URL, VITE_GOOGLE_CLIENT_ID.
    src/
      main.jsx           Mounts <App/> in React.StrictMode + imports index.css.
      index.css          @tailwind + body indigo + dot-grid + CRT classes + reduced-motion.
      App.jsx            ALL UI: App + every screen/overlay component. ~850 lines.
      useGameSocket.js   The socket hook = single source of truth for game state.

  docs/                  (Was: minimalist-arcade-design.md — DELETED by a collaborator,
                          see §11. The design is fully realized in code regardless.)
```

> **Important:** Tailwind v3 is pinned on purpose. v4 moved the PostCSS plugin
> and breaks the `tailwind.config.js` + `@tailwind` directive setup. Do not
> upgrade Tailwind to v4 without migrating the config.

---

## 3. Game rules & configuration

Per-room state machine:

```
LOBBY ──startGame──▶ [3-2-1 COUNTDOWN] ──▶ ROUND_PLAYING ──▶ ROUND_REVEAL ──┐
  ▲                                                                          │ ×10 rounds
  └──────────────────────── restart ◀── GAME_OVER ◀────────────────────────┘
```

Server constants (`server.js` top):

| Const | Value | Meaning |
|---|---|---|
| `MAX_PLAYERS` | 8 | per room |
| `TOTAL_ROUNDS` | 10 | |
| `ROUND_MS` | 10000 | play window; **server-authoritative** |
| `REVEAL_MS` | 3000 | reveal screen pause |
| `EARLY_END_GRACE_MS` | 3000 | after everyone answers, keep the clip playing this long before reveal |
| countdown | 3000ms | pre-round 3-2-1 overlay (audio held until it ends) |
| `QUESTION_BASE/STEP` | 300 / 250 | `questionValue = 300 + roundIndex*250` (round0=300 … round9=2550) |
| `MAX_SPEED_BONUS` | 350 | |
| `ALLOWED_GENRES` | hip-hop, r&b, rap, drill, trap | host picks; validated server-side |

**Scoring (server only, settled at round end):**
- `speedBonus = round(350 * (ROUND_MS - elapsedMs) / ROUND_MS)`, clamped [0,1] ratio.
- `streakBonus`: 2-in-a-row +50, 3 +100, 4+ +200. Resets on wrong/no answer & game start.
- `pointsEarned = questionValue + speedBonus + streakBonus` (correct only; else 0).
- `answerTimeSeconds = round(elapsedMs/10)/100`. `roundWinner` = fastest **correct**
  answerer (wrong answers never win; `null` if none correct).

**Countdown flow (anti-cheat + mobile audio):** `startRound()` builds the round
but holds it in `room.pending` and emits `countdown` (no audio/answer). Phase
stays on the previous screen, so early guesses are rejected. After 3s,
`beginPlaying()` reveals audio/options, sets phase to `ROUND_PLAYING`, starts the
clock. **The audio URL is withheld until the countdown ends** so nobody can
Shazam during it.

**Early-end grace:** when everyone has answered, `endRoundSoon()` keeps the clip
playing up to `EARLY_END_GRACE_MS` (or until the natural 10s end, whichever is
sooner) before revealing — so the song isn't cut off abruptly.

---

## 4. Multi-room model

- `rooms` is a `Map<code, room>`. Codes are 4 chars from
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no confusable chars), unique.
- Each room is fully isolated: own state, `players` Map, `timers` object,
  history, etc. Broadcasts use `io.to(room.code).emit(...)`.
- `socket.data.roomCode` tracks which room a socket is in; `roomOf(socket)`
  resolves it. `socket.data.busy` guards re-entrant create/join (verify is async).
- **Host = first player** in the room's insertion order. Only the host can
  `startGame`. If the host leaves, the next player becomes host (`newHost`).
- Empty rooms are deleted (`deleteRoom`).

---

## 5. Socket event contract (the API)

### Client → Server
| Event | Payload | Notes |
|---|---|---|
| `createRoom` | `{ name, idToken? }` | opens a new room, become host. `idToken` = Google credential (optional). |
| `joinRoom` | `{ code, name, idToken? }` | join existing room by code. |
| `startGame` | `{ genre? }` | host only; fetches pool, starts round 1. |
| `guess` | `{ option }` | one per round; option is a track-name string. |
| `restart` | — | from `GAME_OVER` back to the room lobby. |

### Server → Client
| Event | Payload |
|---|---|
| `roomJoined` | `{ code, id }` (your socket id) |
| `state` | `{ code, phase, round, totalRounds, maxPlayers, audioUrl, options, timeRemainingMs, players: [{ id, name, google, score, hasGuessed, lastRoundScore }] }` — **never contains the correct answer**; `audioUrl`/`options` null outside a round |
| `countdown` | `{ seconds:3, round, questionValue, maxSpeedBonus, maxPoints }` |
| `roundStart` | `{ questionValue, maxSpeedBonus, roundIndex }` |
| `reveal` | `{ correct, round, results:[{ id, name, correct, pointsEarned, streakBonus, currentStreak, answerTimeSeconds, score, gained }], roundWinner:{ name, answerTimeSeconds }｜null, leaderboard:[{ rank, id, name, score }] }` |
| `gameOver` | `{ leaderboard, roundHistory:[{ trackName, artistName, winner }] }` |
| `loading` | `{ message }` (while fetching songs) |
| `guessAck` | `{ accepted:true }` (does NOT reveal correctness) |
| `errorMsg` | `{ message }` |
| `playerLeft` | `{ name }` |
| `newHost` | `{ name }` |
| `waitingForPlayers` | `{}` (only 1 player left mid-game) |

> `gained` is an alias of `pointsEarned` kept for the client. `results` carries
> `currentStreak`/`streakBonus` for the 🔥 badge.

---

## 6. `itunesFetcher.js`

`fetchSongs(genre, count) -> [{ trackName, artistName, previewUrl, trackId }]`

- Hits `https://itunes.apple.com/search?term={genre}&media=music&limit={3*count, max 200}`.
- Filters: must have `previewUrl`, `trackTimeMillis > 20000`; dedupes by `trackId`.
- `sample()` maximizes **artist diversity** (round-robin by artist; every artist
  appears once before any repeats). Never duplicates tracks; never mutates pool.
- **1-hour in-memory cache** per genre; re-samples for variety; stale-cache
  fallback on network error.
- `previewUrl` is an opaque Apple CDN hash (`mzaf_...m4a`) — does **not** contain
  the track name, so it can't leak the answer via the network tab.
- Server `maybeRefreshPool(room)` refetches mid-game when the pool is nearly
  exhausted. (Currently dormant: pool=16, game=10 rounds, so `usedTrackIds`
  never reaches the `pool-4` threshold. Fires if `TOTAL_ROUNDS` > ~12.)

---

## 7. Client architecture

### `useGameSocket.js`
The single source of truth. Opens one socket:
`io(import.meta.env.VITE_SOCKET_URL || window.location.origin, { transports:["websocket"] })`.
Listens to every server event and exposes state + actions:
`{ connected, myId, roomCode, state, reveal, gameOver, loading, error, roundMeta,
   countdown, notice, createRoom, joinRoom, start, guess, restart, clearError, clearNotice }`.
**Contract:** the client never stores/computes the correct answer (only reads
`reveal.correct`, post-round) and never sends a score.

### `App.jsx` components
- `App` — wires the hook; renders overlays (error bar, loading, **countdown
  overlay**, toast) + the screen for the current phase + a persistent **primed
  `<audio>`** at the root.
- `EntryScreen` — Google sign-in button (hidden if no `VITE_GOOGLE_CLIENT_ID`) +
  guest handle + **Create Room** / **Join with code** (prefills `?room=` from URL).
- `GoogleSignIn` — renders the GIS button; on credential, decodes the JWT for a
  display name and passes the raw ID token up (server re-verifies).
- `Lobby` — `1UP/2UP` credit rows (+ green `✓` if Google-verified), the **room
  code** + copy-link, genre toggles, host-only **START GAME**.
- `Playing` — the **CRT scoreboard timer** (`TimeCounter`), QV chip, 4 numbered
  **arcade option buttons** (colors cyan/pink/green/yellow; **keyboard 1–4** to
  answer), audio effect (swap src on the primed element, random offset, stop at
  10s, tap/retry fallbacks).
- `Reveal` — `HIGH SCORE` winner card (gold glow) **or** red glowing `NO ONE GOT
  IT`; per-player rows (`✓/✗/○`, time, points, streak); leaderboard.
- `GameOver` — champion card (gold glow), `HIGH SCORES`, collapsible **See all
  rounds** (`RoundHistory`), `Play again`.
- Overlays/util: `CountdownOverlay` (3-2-1-GO + round worth), `LoadingOverlay`,
  `Toast`, `ErrorBar`, `Leaderboard`, `StatusDot`, `Centered`, `TimeCounter`,
  `useCountdown`.

### Mobile audio (priming)
One persistent `<audio>` at the App root. On the first user gesture (Create/Join,
which calls `primeAudio()`), a tiny silent WAV is played to **unlock** the
element. Each round swaps its `src` and calls `play()` — allowed because the
element is already unlocked, so mobile autoplays without a tap penalty. Fallback
"Tap to play" + "Audio failed — retry" still exist.

---

## 8. Design system — "minimalist arcade, vibrant"

Dark **indigo** canvas + faint dot grid, a structured neon set, monospace
scoreboard, a contained CRT signature. (Lives in `tailwind.config.js` +
`index.css` + class usage in `App.jsx`.)

**Color tokens (Tailwind):**
| Token | Hex | Role |
|---|---|---|
| `void` | `#13131E` | bg (indigo) + dot grid |
| `cabinet` | `#1B1B2A` | panels/cards |
| `rule` | `#2E2E44` | hairline borders |
| `bone` | `#EDEDF2` | primary text |
| `dim` | `#8A8AA0` | secondary text |
| `pink` | `#FF3D7F` | **primary CTA / brand** |
| `amber` | `#FFC93C` | **gold scoreboard / host / rank-1** |
| `cyan` | `#36D8FF` | 1UP labels / option 1 |
| `good` | `#3DF07A` | correct (reveal) / option 3 / verified ✓ |
| `bad` | `#FF4D6D` | wrong / error / miss / option-region |
| `yellow` | `#FFD23F` | option 4 |
| `purple` | `#B14BFF` | spare accent |

> Quirk: the primary-button class constant is still named `BTN_AMBER` in
> `App.jsx` but it's **pink**. `BTN_GHOST` is the secondary outline button.

**Type:** `Archivo` (display/marquee), `Space Mono` (everything functional /
numerals — tabular), `Press Start 2P` (pixel "coin" face, used in exactly two
spots: `INSERT COIN`, `GO`). Loaded via `<link>` in `index.html`.

**CRT signature (`index.css`):** `.crt-scan` (scanline overlay), `.phosphor`
(gold bloom), `.phosphor-pink`, `.phosphor-bad`, `.bezel` (vignette).
`@media (prefers-reduced-motion: reduce)` kills scanlines + all animation.

**Other:** zero border-radius, hairline borders, uppercase mono labels,
`tabular-nums` on all numbers, wordmark **`SNIPPET`** + pink blinking caret.
4-color option buttons mirror real arcade cabinet buttons.

---

## 9. Auth (Google + guest)

- **Frontend:** Google Identity Services button (`GoogleSignIn`). Needs
  `VITE_GOOGLE_CLIENT_ID`; if unset, the button is hidden and the app is
  guest-only. On sign-in it gets a Google **ID token** (JWT) and passes it to
  `createRoom`/`joinRoom`.
- **Server:** verifies the ID token with `google-auth-library`
  (`OAuth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`). The
  verified Google name becomes the player name; **`email`/`sub` are kept
  server-side only** — `publicState` exposes only a `google` boolean (verified
  badge). Guests use a sanitized typed handle. No passwords stored anywhere.

---

## 10. Deployment

See `DEPLOY.md` for click-by-click steps. Summary:

- **Railway (backend):** deploy the repo root; it runs `npm start` (`node
  server.js`). Env: `CLIENT_ORIGIN` = your Vercel URL (CORS allowlist; falls back
  to `*` if unset), `GOOGLE_CLIENT_ID` (optional), `PORT` (auto).
- **Vercel (frontend):** import repo, **Root Directory = `client`**, framework
  Vite. Env: `VITE_SOCKET_URL` = the Railway URL, `VITE_GOOGLE_CLIENT_ID`
  (optional). `vercel.json` adds the SPA rewrite for `?room=CODE`.
- **Google Cloud:** create a Web OAuth client; add the Vercel URL (+
  `http://localhost:5173`) as Authorized JavaScript origins; put the Client ID in
  both `VITE_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID`. No client secret needed.

> The user must do the Railway/Vercel/Google account + secret steps themselves
> (Claude cannot create accounts or enter credentials).

---

## 11. Known issues, quirks & gotchas

- **In-memory state, single instance.** No DB, no Redis adapter. All rooms live
  in `server.js` memory → a Railway redeploy/restart wipes active games, and you
  can only run **one** backend instance. Fine for launch; see §13 to scale.
- **Genre accuracy.** iTunes `term=` is a loose text search, not a strict genre
  filter; it can cluster one artist. Artist-diversity sampling mitigates, but
  results are bounded by what the pool contains. Consider iTunes `genreId`.
- **Pool refetch dormant** at 16-pool / 10-round (see §6).
- **A collaborator has write access.** `chitt (chittranshsharma)` pushed a commit
  deleting `docs/minimalist-arcade-design.md` mid-project. If that's unexpected,
  review repo access. The design is fully implemented in code regardless.
- **post-commit hook** auto-pushes every commit; it prints a harmless error if it
  fires during a `git rebase` (detached HEAD). The real push still succeeds.
- **Session-environment quirks (not code bugs):** in the dev sandbox the Vite
  process sometimes died when backgrounded (just restart `npm run dev`), and
  browser-automation typing into freshly-loaded React inputs occasionally needed
  a ~0.4s settle wait before the text registered.
- The **actual Google sign-in button + token verification could not be tested**
  without a real `GOOGLE_CLIENT_ID`; the code is correct and the guest path +
  graceful no-client-id hiding are verified.

---

## 12. Hard rules (do NOT violate)

1. Server never sends the correct answer during `ROUND_PLAYING`
   (`publicState` omits `room.correct`; only `reveal` discloses it, post-round).
2. Client never computes/stores the correct answer before reveal.
3. The round timer lives on the server; the client countdown is display-only.
4. Score is computed server-side only; the client never sends a score.
5. One guess per player per round (rejected server-side).
6. **No TypeScript** — plain `.jsx`/`.js`.
7. **No UI libraries** — Tailwind only (no shadcn/MUI/chakra).
8. Dark theme always.
9. Green/red appear **only** on the reveal (functional, never decorative); always
   paired with a glyph (`✓/✗`) so meaning isn't color-only.
10. No emoji as structural icons (typographic glyphs like `▶ ↻ ✓ ✗ ○ ●` are fine).

---

## 13. Verification approach (how this was tested)

There is no formal test runner, but throughout development the game loop was
verified with **headless Socket.IO smoke tests** (`node` + `socket.io-client`
scripts that spawn the server on a scratch port and assert behavior). Patterns
used: round flow, scoring exactness, no-answer-leak deep scans, multi-room
isolation, disconnect/host-promotion, name sanitization, guest/Google identity.
**Recommend formalizing these into a `vitest` suite** (see §14). Visual screens
were verified in a real browser via screenshots.

---

## 14. Future implementations & ideas

**Scale & persistence**
- **Redis adapter** (`@socket.io/redis-adapter`) + externalize room state → run
  multiple backend instances behind Railway.
- **Postgres** (Railway add-on) for persistent accounts, global high-score
  leaderboards, match history, and per-user stats (Google `sub` as the key).
- **Reconnect / rejoin** mid-game (currently a disconnect is final because state
  is in memory and join is lobby-only).

**Gameplay**
- **Public quickplay** lobby + simple matchmaking, alongside private rooms.
- **Difficulty settings** (timer 15 / 10 / 7.5s like SongTrivia2; round count;
  number of options).
- **Better song sourcing**: iTunes `genreId`/`attribute=genreIndex` for real
  genres; decade filters; bigger pools; smarter distractors (avoid same-artist).
- **Spectator mode**; **rematch with same players**; **tournaments/brackets**;
  **daily challenge**; **ELO/ranked**.
- Round variety (guess the artist vs the title; "finish the lyric"; intro-only).

**Auth & social**
- Avatars from the Google profile picture (already have `picture` in the token).
- Lobby **chat / emotes**; reactions on the reveal.
- Profanity filter on guest handles; connection rate-limiting for abuse.

**Polish & UX**
- **Sound design**: UI blips, correct/wrong stings, with a volume/mute control.
- **PWA** (installable, offline messaging); deeper mobile + landscape polish.
- **Accessibility audit**: full keyboard coverage, screen-reader labels, focus
  management on phase changes, `aria-live` for toasts/errors.
- Theme variants (an `anthropic-skills:theme-factory`-style skin switcher);
  animated hi-score roll; neon glow on option borders.
- i18n.

**Infra & quality**
- **CI** (GitHub Actions): client `npm run build` + a lint + the headless socket
  tests on every push.
- **Vitest** suite formalizing the smoke tests in §13.
- Error monitoring (Sentry) + structured logging; basic analytics (rounds
  played, popular genres).
- Custom domain; lock CORS to the exact Vercel origin in prod.

**Licensing note:** the game uses Apple's free **preview** clips (legal for
previews). A full Spotify/Apple Music integration for whole tracks would require
proper licensing — don't ship that casually.

---

## 15. Recent git history (most recent last)

```
… (early: initial commit, README, design PASS 2, features F1–F6, PASS 4 security)
mobile audio priming  →  countdown round-worth + early-end grace
arcade reskin  →  vibrant palette  →  rename to SNIPPET + vibrant reveal
Phase 1: multi-room + env/CORS + deploy config (vercel.json, DEPLOY.md, .env.example)
Phase 2: Google sign-in (GIS) + guest auth        ← current HEAD
```

The codebase is the source of truth; this doc summarizes intent. When in doubt,
read `server.js` (engine + contract), `useGameSocket.js` (client state), and
`App.jsx` (UI). Good luck — and keep the §12 hard rules intact.
