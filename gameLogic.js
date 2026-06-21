// Pure, side-effect-free game logic — extracted from server.js so it can be
// unit-tested without spinning up a server or hitting the network. Nothing here
// touches sockets, timers, or rooms; it's all deterministic given its inputs
// (except shuffle/buildRound, which use Math.random by design).

import { maskProfanity } from "./profanity.js";

// ----- Scoring constants -----
export const QUESTION_BASE = 300;
export const QUESTION_STEP = 250;
export const MAX_SPEED_BONUS = 350;

// ----- Host-configurable settings (allowlists; first item is the default) -----
export const ROUND_CHOICES = [10, 5, 15];
export const TIMER_CHOICES = [10000, 7500, 15000];
export const OPTION_CHOICES = [4, 3, 6];
export const MODE_CHOICES = ["TITLE", "ARTIST"];
export const DECADE_CHOICES = ["all", "2020s", "2010s", "2000s", "1990s"];
// Clip start: RANDOM plays from a random offset; INTRO (Heardle-style) plays
// from the very start of the track. The offset itself is applied client-side;
// the server just records the choice and tells the client via state.clip.
export const CLIP_CHOICES = ["RANDOM", "INTRO"];
export const ALLOWED_GENRES = ["hip-hop", "r&b", "rap", "drill", "trap"];

export const DEFAULT_SETTINGS = {
  rounds: ROUND_CHOICES[0],
  roundMs: TIMER_CHOICES[0],
  optionsCount: OPTION_CHOICES[0],
  mode: MODE_CHOICES[0],
  decade: DECADE_CHOICES[0],
  clip: CLIP_CHOICES[0],
  genre: "hip-hop",
};

// Coerce an untrusted settings payload into a safe, fully-populated object.
export function sanitizeSettings(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const pick = (val, choices) => (choices.includes(val) ? val : choices[0]);
  const genre = String(p.genre ?? "").toLowerCase();
  return {
    rounds: pick(Number(p.rounds), ROUND_CHOICES),
    roundMs: pick(Number(p.roundMs), TIMER_CHOICES),
    optionsCount: pick(Number(p.optionsCount), OPTION_CHOICES),
    mode: pick(String(p.mode || "").toUpperCase(), MODE_CHOICES),
    decade: pick(String(p.decade || "").toLowerCase(), DECADE_CHOICES),
    clip: pick(String(p.clip || "").toUpperCase(), CLIP_CHOICES),
    genre: ALLOWED_GENRES.includes(genre) ? genre : DEFAULT_SETTINGS.genre,
  };
}

// Pool size needed for a match: enough distinct tracks for every round plus a
// full set of distractors, with headroom. Bounded so we never hammer the API.
export function poolSizeFor(settings) {
  return Math.min(60, Math.max(16, settings.rounds + settings.optionsCount + 6));
}

// Allow letters, digits, space, underscore, hyphen; then mask guest profanity.
export function cleanName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[^a-zA-Z0-9 _\-]/g, "")
    .trim()
    .slice(0, 20);
  return maskProfanity(cleaned);
}

// Fisher-Yates on a copy. Never mutates the input.
export function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Build one round: a correct track + (optionsCount - 1) distractors. In TITLE
// mode the options are track names; in ARTIST mode they are artist names. Every
// option is a distinct value AND (where the pool allows) a distinct artist.
export function buildRound(pool, usedTrackIds, settings) {
  const need = settings.optionsCount - 1;
  const valueOf = settings.mode === "ARTIST" ? (t) => t.artistName : (t) => t.trackName;

  const unused = pool.filter((t) => !usedTrackIds.has(t.trackId));
  const candidates = unused.length > 0 ? unused : pool;
  const correct = candidates[Math.floor(Math.random() * candidates.length)];
  const correctValue = valueOf(correct);

  const usedValues = new Set([correctValue]);
  const usedArtists = new Set([correct.artistName]);
  const distractors = [];
  const others = shuffle(pool.filter((t) => t.trackId !== correct.trackId));

  // First pass: distinct artist and distinct displayed value.
  for (const t of others) {
    if (distractors.length === need) break;
    if (usedArtists.has(t.artistName)) continue;
    if (usedValues.has(valueOf(t))) continue;
    distractors.push(t);
    usedArtists.add(t.artistName);
    usedValues.add(valueOf(t));
  }
  // Fallback: relax the distinct-artist rule, keep distinct displayed values.
  if (distractors.length < need) {
    for (const t of others) {
      if (distractors.length === need) break;
      if (usedValues.has(valueOf(t))) continue;
      distractors.push(t);
      usedValues.add(valueOf(t));
    }
  }

  const options = shuffle([correctValue, ...distractors.map(valueOf)]);
  return {
    audioUrl: correct.previewUrl,
    options,
    correct: correctValue,
    artistName: correct.artistName,
    trackName: correct.trackName,
    trackId: correct.trackId,
  };
}

export function questionValueFor(roundIndex) {
  return QUESTION_BASE + roundIndex * QUESTION_STEP;
}
export function speedBonusFor(elapsedMs, roundMs) {
  const ratio = Math.max(0, Math.min(1, (roundMs - elapsedMs) / roundMs));
  return Math.round(MAX_SPEED_BONUS * ratio);
}
export function streakBonusFor(streak) {
  if (streak >= 4) return 200;
  if (streak === 3) return 100;
  if (streak === 2) return 50;
  return 0;
}
