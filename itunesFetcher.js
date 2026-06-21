// iTunes preview fetcher for the song-guessing game.
//
// Pulls real, legally streamable preview clips from the public iTunes Search
// API (no auth required). Previews are short AAC/M4A files served straight from
// Apple's CDN.
//
// METADATA NOTE: nothing is stripped here on purpose. The preview is streamed
// from Apple's CDN as-is, and the previewUrl is an opaque, random-hashed path
// (e.g. .../mzaf_<hash>.plus.aac.p.m4a) that does NOT contain the track name,
// so it cannot leak the answer to a client inspecting the network tab.

import fetch from "node-fetch";

// ----- Constants -----
// The endpoint is overridable via ITUNES_BASE so tests can point at a local
// fixture server (offline, deterministic) instead of the live iTunes API.
const SEARCH_BASE = process.env.ITUNES_BASE || "https://itunes.apple.com/search";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ITUNES_MAX_LIMIT = 200;        // hard ceiling enforced by the iTunes API
const MIN_DURATION_MS = 20 * 1000;   // duration must be > 20 seconds

// In-memory cache: genre (lowercased) -> { pool, ts }.
// We cache the filtered POOL, not a single result set, so repeated calls for
// the same genre re-sample for variety without hammering the API.
const cache = new Map();

// ----- Helpers -----

// Fisher-Yates on a COPY. Never mutate the cached pool.
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Sample up to n items, maximizing artist diversity.
// Tracks are grouped by artist, then chosen round-robin (one per artist per
// pass). The first pass yields all-unique artists; only once every artist has
// been used do later passes add a second/third track from the same artist. So
// for any n, artist variety is as high as the pool allows. If the pool is too
// small to reach n with unique artists, repeats are allowed but diversity stays
// prioritized (every artist appears once before any appears twice). Distinct
// tracks are never duplicated, and the pool is never mutated.
function sample(pool, n) {
  const want = Math.min(n, pool.length);
  if (want <= 0) return [];

  // Group by artist from a shuffled copy (randomized order, pool untouched).
  const byArtist = new Map();
  for (const track of shuffle(pool)) {
    const key = track.artistName;
    if (!byArtist.has(key)) byArtist.set(key, []);
    byArtist.get(key).push(track);
  }

  // Round-robin across artists (in random order) until we have `want` tracks.
  const groups = shuffle([...byArtist.values()]);
  const out = [];
  while (out.length < want) {
    let picked = false;
    for (const group of groups) {
      if (group.length === 0) continue;
      out.push(group.shift());
      picked = true;
      if (out.length === want) break;
    }
    if (!picked) break; // nothing left to pick
  }
  return out;
}

// Turn raw iTunes results into clean game items.
// Filters: must have previewUrl, must be longer than 20s. Dedupes by trackId
// (iTunes can return the same track from multiple albums) to avoid repeats.
// releaseYear is kept so callers can filter by decade.
function normalize(results) {
  const list = Array.isArray(results) ? results : [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || !r.previewUrl) continue;                       // need a playable preview
    if (!(Number(r.trackTimeMillis) > MIN_DURATION_MS)) continue; // duration > 20s
    if (seen.has(r.trackId)) continue;                       // dedupe -> avoid repeats
    seen.add(r.trackId);
    out.push({
      trackName: r.trackName,
      artistName: r.artistName,
      previewUrl: r.previewUrl,
      trackId: r.trackId,
      releaseYear: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : null,
    });
  }
  return out;
}

// Decade filtering. Ranges are inclusive; "all" (or unknown) means no filter.
const DECADE_RANGES = {
  "2020s": [2020, 2029],
  "2010s": [2010, 2019],
  "2000s": [2000, 2009],
  "1990s": [1990, 1999],
};
function filterDecade(pool, decade) {
  const range = DECADE_RANGES[decade];
  if (!range) return pool;
  const [lo, hi] = range;
  return pool.filter((t) => t.releaseYear != null && t.releaseYear >= lo && t.releaseYear <= hi);
}

// Sample n tracks, preferring the requested decade. If the decade yields fewer
// than n, fall back to the full pool so a game can always start.
function pickFrom(pool, n, decade) {
  const filtered = filterDecade(pool, decade);
  const usable = filtered.length >= n ? filtered : pool;
  return sample(usable, n);
}

// ----- Public API -----

// Fetch `count` random preview tracks for a genre/search term.
// Over-fetches the requested count (capped at the iTunes 200 max) so that after
// filtering and deduping there is still enough to sample from. opts.decade
// ("2020s" | "2010s" | "2000s" | "1990s" | "all") biases the sample toward a
// decade, falling back to the full pool when too few match.
export async function fetchSongs(genre, count, opts = {}) {
  const term = String(genre ?? "").trim();
  if (!term) throw new Error("genre is required");

  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return [];

  const decade = (opts && opts.decade) || "all";
  const key = term.toLowerCase();
  const cached = cache.get(key);
  const isFresh = cached && Date.now() - cached.ts < CACHE_TTL_MS;

  // Use the cache only if it is fresh AND large enough to satisfy this request.
  if (isFresh && cached.pool.length >= n) {
    return pickFrom(cached.pool, n, decade);
  }

  // Over-fetch 5x the requested count (decade filtering can thin a pool a lot),
  // capped at the iTunes 200 max.
  const limit = Math.min(Math.max(n * 5, n), ITUNES_MAX_LIMIT);
  const url =
    `${SEARCH_BASE}?term=${encodeURIComponent(term)}&media=music&limit=${limit}`;

  let pool;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`iTunes API responded ${res.status}`);
    const data = await res.json();
    pool = normalize(data.results);
  } catch (err) {
    // On a network failure, fall back to stale cache if we have any.
    if (cached) return pickFrom(cached.pool, n, decade);
    throw err;
  }

  cache.set(key, { pool, ts: Date.now() });
  return pickFrom(pool, n, decade);
}

// Clear the in-memory cache (handy for tests).
export function clearCache() {
  cache.clear();
}

// Exposed for tests/inspection only.
export const _cache = cache;

export default fetchSongs;
