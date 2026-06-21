# Name·That·Track — "MINIMALIST ARCADE" Design Draft

> Status: **design draft / direction** (not built yet). Targets the existing
> React + Vite + Tailwind client (`client/src/App.jsx`, `useGameSocket.js`).
> The server, scoring, and socket contract do **not** change — this is a skin +
> motion + type system over the current screens.

---

## 0. Thesis (one line)

**A monochrome arcade cabinet rendered as a quiet document** — black void, one
amber phosphor, a monospace scoreboard, and a single CRT signature. Arcade
*soul*, minimalist *discipline*. The screen looks like the readout of a machine,
not a neon billboard.

### How the three skills shaped this (and where they fought)

- **ui-ux-pro-max** (DB) returned: Space Mono, Pixel-Art family, single column,
  marquee + blinking-cursor effects, "neon red+blue on dark + score green."
  → I **kept** Space Mono + single column + marquee/cursor; I **rejected** the
  neon red/blue (too loud) for one restrained accent.
- **minimalist-ui** demands scarce color, hairline borders, monospace for data,
  no emoji icons, typographic contrast — but defaults to *light/warm editorial*.
  → I took its **discipline**, applied it to a **dark** brief.
- **frontend-design** warns that "near-black background + one acid-green/vermilion
  accent" is a current AI cliché, and to spend boldness in exactly one place.
  → So the accent is **amber #FFB000** (CRT monochrome-monitor phosphor — warm,
  historically literal to arcades, *not* the acid-green default), and the
  boldness is spent on **one** signature: the CRT scoreboard.

**The one risk:** a real CRT treatment (scanlines + phosphor bloom + vignette),
contained to the timer/score so it reads as the machine's display, not chrome.
Fully disabled under `prefers-reduced-motion`.

---

## 1. Design tokens

### 1.1 Color — bone on void, one amber phosphor

| Token | Hex | Role | Contrast on `--void` |
|---|---|---|---|
| `--void` | `#0A0B0D` | app background (the dark behind the glass) | — |
| `--cabinet` | `#131418` | panels, cards, option fills | — |
| `--rule` | `#24262C` | 1px hairline borders / dividers | — |
| `--bone` | `#ECEAE1` | primary text (warm off-white, phosphor-ish) | ~15:1 AAA |
| `--dim` | `#777C85` | labels, secondary text | ~4.6:1 AA |
| `--amber` | `#FFB000` | THE accent: active, focus, score glow, coin | ~9:1 AAA(large) |
| `--amber-wash` | `rgba(255,176,0,.12)` | active fills, selected option bg | — |
| `--good` | `#34D27B` | correct — **reveal only**, never decorative | ~8:1 |
| `--bad` | `#FF5C5C` | wrong / errors — **reveal only** | ~5:1 |

Rules: amber is the *only* brand color and is used sparingly (one accent per
view). Green/red appear **only** on the reveal to mark answers, and always pair
with a glyph (`✓ / ✗`) so meaning never rides on color alone.

### 1.2 Typography — three faces, strict roles

| Role | Face | Weights | Used for |
|---|---|---|---|
| **Marquee** (display) | `Archivo` (wide, 800–900) | 900 | masthead, winner name, GAME OVER, "GO" sizing |
| **Console** (everything functional) | `Space Mono` | 400 / 700 | options, labels, scores, timer digits, copy |
| **Coin** (signature, 1 place only) | `Press Start 2P` | 400 | the `INSERT COIN` wordmark + the countdown `GO` |

```css
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap');
```

- **Type scale (px):** 11 · 13 · 15 · 18 · 24 · 40 · 64 · **96** (timer).
- **Tracking:** Console labels = `uppercase` + `0.18em` (machine-label feel);
  Marquee = tight `-0.02em`; body Console = normal.
- **Numerals:** always `tabular-nums` (mono is tabular by default) so timer and
  scores never reflow — this is an arcade scoreboard, digits must not jiggle.

### 1.3 Structure

- **Radius:** `0` everywhere. Arcades are rectangles. (Exception: the credit
  dot.) This is the cleanest break from the current rounded-ish look.
- **Border:** exactly `1px solid var(--rule)`. No drop shadows anywhere except
  the amber *glow* (text-shadow) on the scoreboard.
- **Grid:** single centered column, `max-w-[34rem]`, generous vertical rhythm
  (`space-y-8`), framed top+bottom by hairline rules (the cabinet bezel).
- **Spacing:** 4/8 scale. Section gaps 24/32; in-card padding 16/20/24.

### 1.4 Motion tokens

| Token | Value | Use |
|---|---|---|
| `--t-micro` | 160ms ease-out | hover/press/selection |
| `--t-move` | 240ms `cubic-bezier(.16,1,.3,1)` | overlays, entrances |
| `--t-exit` | 140ms ease-in | exits (~60% of enter) |
| stagger | 40ms/item | lists (leaderboard, options) |

All motion is `transform`/`opacity` only. Everything below is gated by
`@media (prefers-reduced-motion: reduce)` → no flicker, no score-roll, scanlines
go static, durations collapse to 0–60ms.

---

## 2. The signature: CRT scoreboard

The one memorable element. Applied to the **timer** and **score pops** only.

```css
/* scanlines: a fixed, non-interactive overlay over the whole app */
.crt-scan::after{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:60;
  background:repeating-linear-gradient(rgba(0,0,0,0) 0 2px, rgba(0,0,0,.16) 2px 3px);
  mix-blend-mode:multiply;
}
/* phosphor bloom on amber digits */
.phosphor{ color:var(--amber);
  text-shadow:0 0 2px rgba(255,176,0,.7), 0 0 10px rgba(255,176,0,.45); }
/* barrel vignette on the play frame */
.bezel{ box-shadow: inset 0 0 120px rgba(0,0,0,.6); }
/* subtle flicker — disabled under reduced-motion */
@keyframes flicker{ 0%,97%{opacity:1} 98%{opacity:.82} 100%{opacity:1} }
.flicker{ animation:flicker 4s steps(1) infinite; }
@media (prefers-reduced-motion: reduce){
  .flicker{animation:none} .crt-scan::after{background:none}
}
```

The timer (`TimeCounter`) becomes a large `phosphor` Space Mono `0:08`. When ≤3s
it shifts amber → `--bad` red with a faster flicker. Scores tick up with a
rolling-counter (`scoreroll`) instead of snapping.

---

## 3. Screens (wireframes + notes)

Cabinet frame is constant: hairline top **marquee** bar, centered play column,
hairline bottom **control-panel** bar (credits / handle / online dot).

### 3.1 Join — "INSERT COIN"

```
┌───────────────────────────── marquee ─────────────────────────────┐
│  NAME · THAT · TRACK                                  SIDE A · LOBBY│
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                        I N S E R T   C O I N      ← Press Start 2P  │
│                        ─────────────────────                       │
│                        pick a handle to play                       │
│                                                                    │
│        ┌──────────────────────────────────────────────┐           │
│        │ YOUR HANDLE_                          (blink) │  ← amber   │
│        └──────────────────────────────────────────────┘  caret     │
│        [          P R E S S   S T A R T          ]   ← amber btn    │
│                                                                    │
├──────────────────────────── control panel ────────────────────────┤
│  ● ONLINE                                              CREDITS: 0  │
└────────────────────────────────────────────────────────────────────┘
```

- Input: underline-only, transparent, with a **blinking amber block caret**
  (the DB's "blinking cursor" effect, done once, here).
- Primary button = solid amber, black text, `PRESS START`. Press = `scale(.98)` +
  a one-frame `coinflash` (amber → white → amber).
- "CREDITS: 0" is flavor that becomes the player count once in a room.

### 3.2 Lobby — credits roster + cabinet genre selector

```
│  PLAYERS  03 / 08                                                  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 1UP  ALICE                                      [HOST]·amber  │ │  ← 1UP/2UP
│  │ 2UP  BOB                                              · YOU   │ │  rows,
│  │ 3UP  CARL                                                     │ │  alt fills
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  GENRE                                                             │
│  [ HIP-HOP ]  [ R&B ]  [ RAP ]  [ DRILL ]  [ TRAP ]   ← cabinet    │
│     ▲ selected = solid amber                            toggles    │
│                                                                    │
│  SHARE  http://…:5173        [COPY]                                │
│  [             ▶  S T A R T   G A M E              ]   (host only) │
```

- Players render as **1UP / 2UP / 3UP** credit rows (the arcade nod), alternating
  `--cabinet`/`#0F1013` fills, host marked with an amber `[HOST]`, you with a dim
  `· YOU`.
- Genre = horizontal **cabinet toggle** row; selected pill is solid amber/black,
  others hairline. (Replaces current pills with squarer arcade buttons.)
- Non-host sees a blinking `WAITING FOR HOST` line instead of START.

### 3.3 Countdown — round worth (already requested, restyled)

```
│                         R O U N D   03                            │
│                                                                    │
│                              3                ← Marquee, phosphor   │
│                          (then 2, 1, GO)        GO = Press Start 2P │
│                                                                    │
│                   WORTH  800  PTS THIS ROUND                       │
│                   up to 1150 if you answer fastest  ← amber line    │
```

- The numerals snap with a single CRT `flicker` per tick. `GO` swaps to the
  pixel **Coin** face — the second (and last) place the pixel font appears.
- Worth/max lines already wired from the `countdown` payload.

### 3.4 Playing — the scoreboard

```
│  TRACK 03 / 10                          [ QV 800 · SPEED ≤350 ]    │
│                                                                    │
│        TIME                                                        │
│                          0 : 0 8        ← 96px phosphor (signature) │
│        ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  ← amber depletion bar (1s linear)    │
│                                                                    │
│   ▌ ►  (clip playing — waveform tick, optional)                   │
│                                                                    │
│   ┌── 1 ──────────────────────┐   press 1 / tap                   │
│   │ ISLAND CHEMISTRY          │   ← arcade buttons, hairline,      │
│   ├── 2 ──────────────────────┤     amber ring on hover/focus,     │
│   │ LOCO                       │     number-keyed (1–4)            │
│   ├── 3 ──────────────────────┤                                   │
│   │ TRUMAN (LIVE SESSION)      │                                   │
│   ├── 4 ──────────────────────┤                                   │
│   │ SUNFLOWER                  │                                   │
│   └────────────────────────────┘                                  │
│                 pick the track — faster = more points              │
```

- **Timer** = the CRT signature (big amber phosphor, scanlines over it,
  red+fast-flicker under 3s).
- **Options** become **arcade buttons**: hairline box, a small amber index
  `1–4` on the left (and **keyboard 1–4 to answer** — very arcade, also an a11y
  win). Hover/focus = amber ring + `--amber-wash` fill. Selected/locked =
  solid amber ring + `LOCKED` tag, others drop to 30% (existing lock anim, kept).
- The value banner shrinks into a compact `QV 800 · SPEED ≤350` chip top-right
  (the full worth already shown on the countdown, so this is just a reminder).

### 3.5 Reveal — "HIGH SCORE"

```
│  ROUND 03 / 10                                ANSWER  LIVING TOO FAST(opt)│
│  ┌────────────────────────────────────────────────────────────────┐ │
│  ▌ HIGH SCORE                                                       │ │ ← amber
│  ▌ CARL                                          5.13s     +1470   │ │   left bar
│  ▌ 🔥 STREAK +100  (amber)                                         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  THIS ROUND                                                         │
│   ✓ CARL     5.13s   +1470   (good)                                 │
│   ✗ ALICE    6.20s   +0      (bad ✗)                                │
│   ○ BOB        —      +0      (dim ○)                                │
│  LEADERBOARD                                                        │
│   01  CARL    1470   (rank 1 = bone/amber)                          │
│   02  ALICE   0                                                     │
```

- Winner card titled **HIGH SCORE** (arcade vernacular) with the amber left
  accent bar + big `+points` (Marquee). Streak badge in amber.
- Per-player keeps `✓ / ✗ / ○` glyphs (color-not-only). Correct points in
  `--good`. Times in tabular Console.
- Leaderboard rank-1 row gets the amber/bone emphasis; rest `--dim`.

### 3.6 Game Over — "HIGH SCORES" table + replay

```
│                         G A M E   O V E R          ← Marquee 900    │
│  ┌────────────── champion ──────────────┐                          │
│  │ 1UP   CARL                           │   ← amber-framed card     │
│  │       9,420                          │   big Marquee number      │
│  └──────────────────────────────────────┘                          │
│  HIGH SCORES                                                       │
│   02  ALICE   6,110                                                 │
│   03  BOB     5,300                                                 │
│   ▶ SEE ALL ROUNDS   (collapsible recap, existing)                 │
│  [            ↻  P L A Y   A G A I N            ]   ← solid amber    │
```

- Final board styled as a classic **HIGH SCORES** table. Champion is a 1UP
  amber-framed card with a Marquee score.
- `PLAY AGAIN` = solid amber primary.

### 3.7 System layers

- **Loading** (`fetchSongs`): full-screen void, centered `LOADING SONGS` in
  Console + a blinking amber caret (no spinner — on-theme).
- **Toasts** (player left / new host): bottom hairline bar, Console, auto-dismiss
  3s, `aria-live="polite"`.
- **Error bar**: top hairline bar, `--bad` text, `role="alert"`.
- **Audio-retry**: amber outline button (kept; amber is allowed, it's the brand).

---

## 4. Component specs (delta from current code)

| Component (`App.jsx`) | Change |
|---|---|
| `Masthead` | Marquee face; render title as `NAME · THAT · TRACK`; right label uppercase Console. |
| `JoinScreen` | Underline input + blinking amber caret; `INSERT COIN` (Coin face) + `PRESS START` amber button. |
| `Lobby` | 1UP/2UP credit rows; cabinet genre toggles; amber `[HOST]`. |
| `CountdownOverlay` | `ROUND N`, phosphor numerals, `GO` in Coin face, worth lines. |
| `Playing` | CRT timer signature; options → numbered arcade buttons + **keys 1–4**; compact QV chip. |
| `TimeCounter` | becomes the `phosphor` 96px display + amber depletion bar; red+flicker ≤3s. |
| `Reveal` | `HIGH SCORE` winner card; keep glyphs; green→`--good`. |
| `GameOver` | `GAME OVER` Marquee; `HIGH SCORES` table; amber champion + Play Again. |
| `Leaderboard` | rank-1 emphasis; Console tabular scores. |
| new: `Scoreboard` digits, `CreditRow`, `GenreToggle`, `BlinkCaret` | small primitives. |

No SVG-icon library needed (minimalist-ui bans thin-line/emoji icons); the few
glyphs (`▶ ↻ ✓ ✗ ○ ●`) are typographic and consistent. If we want crisper marks,
use **Phosphor Icons (Bold)** — the one set, one stroke.

---

## 5. Motion & micro-interactions (ui-ux-pro-max compliant)

- Buttons: `:active scale(.98)`, 160ms; amber ring grows on focus.
- Coin flash on `PRESS START` and option-lock: 1 frame amber→white→amber.
- Score: rolling counter on reveal/leaderboard (`scoreroll`), not a snap.
- Leaderboard / options: 40ms stagger entrance (`translateY(8px)`+fade).
- Countdown numerals: single `flicker` per tick; `GO` scales 1.0→1.08→1.0.
- Overlays animate from center (scale .96→1 + fade), exit ~60% faster.
- **Reduced-motion:** all of the above collapse to instant; CRT static.

---

## 6. Accessibility & quality floor (non-negotiable)

- **Contrast:** bone/void AAA, dim/void AA, amber/void AAA-large; verify `--bad`
  pairs at ≥4.5:1.
- **Keyboard:** 1–4 select options, Enter submits handle, Space = Start (host);
  visible amber focus ring (2px) on everything; tab order matches layout.
- **Color-not-only:** `✓/✗/○` glyphs + position carry correctness, not hue.
- **Touch:** option buttons ≥56px tall, ≥8px gaps; everything ≥44px.
- **Tabular numerals** on timer/scores (no reflow).
- **Reduced-motion** + **dynamic type** respected; layout holds at 375px.
- **Audio:** keep the priming + tap-fallback; never hide the retry path.

---

## 7. Implementation map (existing stack)

1. **Fonts:** add the `@import` to `client/src/index.css` (or `<link>` in
   `index.html`, preconnect to fonts.gstatic).
2. **Tailwind** (`tailwind.config.js`) extend:
   ```js
   theme:{ extend:{
     colors:{ void:'#0A0B0D', cabinet:'#131418', rule:'#24262C',
              bone:'#ECEAE1', dim:'#777C85', amber:'#FFB000',
              good:'#34D27B', bad:'#FF5C5C' },
     fontFamily:{ marquee:['Archivo','sans-serif'],
                  console:['"Space Mono"','monospace'],
                  coin:['"Press Start 2P"','monospace'] },
     borderRadius:{ none:'0' },
     keyframes:{ blink:{'50%':{opacity:'0'}},
       flicker:{'0%,97%':{opacity:'1'},'98%':{opacity:'.82'},'100%':{opacity:'1'}},
       scoreroll:{from:{transform:'translateY(0.4em)',opacity:'0'},to:{transform:'none',opacity:'1'}} },
     animation:{ blink:'blink 1s step-end infinite', flicker:'flicker 4s steps(1) infinite' },
   }}
   ```
3. **CSS:** add `.crt-scan`, `.phosphor`, `.bezel` to `index.css`; wrap the app
   root in `crt-scan` and the play column in `bezel`.
4. **Components:** apply the deltas in §4. Swap the shared class fragments
   (`EYEBROW`, `PANEL`, `BTN`) to the new tokens — most screens inherit the look
   from those three constants, so this is a high-leverage change.
5. **Server/socket:** unchanged. The `countdown` worth payload and all reveal
   fields already exist.

---

## 8. Build phases

1. **Tokens + fonts + the three shared fragments** (instant 70% reskin).
2. **CRT timer signature** + Playing arcade buttons + keys 1–4.
3. Lobby credit rows + genre toggles; Join INSERT COIN.
4. Reveal HIGH SCORE + Game Over HIGH SCORES + score-roll.
5. Motion polish + reduced-motion + a11y audit (contrast, focus, 375px).

---

## 9. Open choices for you

- **Accent:** amber (recommended, CRT-literal) vs a cooler "CRT green-phosphor"
  `#7CFFB0` (more classic, but closer to the cliché frontend-design warns about).
- **Pixel font reach:** keep it to 2 spots (`INSERT COIN`, `GO`) — or zero, if
  you want pure minimal with no pixel face at all.
- **Scanlines:** global-subtle vs play-screen-only.
- **Wordmark:** keep `NAME·THAT·TRACK`, or lean fully arcade → `TRACKADE` /
  `HEAR·HERO` (new name).

Say which way on §9 and I'll build phase 1 (tokens + shared fragments) so you see
the reskin live in a few minutes.
