import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock node-fetch (the module imports the default export) so these tests are
// fully offline and deterministic.
vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { fetchSongs, clearCache } from "../itunesFetcher.js";

const ok = (results) => ({ ok: true, json: async () => ({ results }) });

const RESULTS = [
  { trackId: 1, trackName: "A", artistName: "Ann", previewUrl: "u1", trackTimeMillis: 30000, releaseDate: "2021-01-01T00:00:00Z" },
  { trackId: 1, trackName: "A", artistName: "Ann", previewUrl: "u1", trackTimeMillis: 30000, releaseDate: "2021-01-01T00:00:00Z" }, // dupe trackId
  { trackId: 2, trackName: "B", artistName: "Ben", previewUrl: "u2", trackTimeMillis: 30000, releaseDate: "2015-01-01" },
  { trackId: 3, trackName: "C", artistName: "Cara", previewUrl: "u3", trackTimeMillis: 30000, releaseDate: "2003-01-01" },
  { trackId: 4, trackName: "D", artistName: "Dee", previewUrl: "u4", trackTimeMillis: 10000, releaseDate: "2019-01-01" }, // too short
  { trackId: 5, trackName: "E", artistName: "Eli", previewUrl: null, trackTimeMillis: 30000, releaseDate: "2019-01-01" }, // no preview
  { trackId: 6, trackName: "F", artistName: "Ann", previewUrl: "u6", trackTimeMillis: 40000, releaseDate: "2015-06-01" },
];

beforeEach(() => {
  clearCache();
  fetch.mockReset();
});

describe("fetchSongs (mocked iTunes)", () => {
  it("normalizes: drops no-preview/too-short, dedupes by trackId", async () => {
    fetch.mockResolvedValue(ok(RESULTS));
    const out = await fetchSongs("rap", 10);
    const ids = out.map((t) => t.trackId).sort();
    // valid: 1, 2, 3, 6 (4 too short, 5 no preview, dup 1 removed)
    expect(ids).toEqual([1, 2, 3, 6]);
    expect(out.every((t) => t.previewUrl && t.trackName && t.artistName)).toBe(true);
  });

  it("biases toward a decade but falls back when too sparse", async () => {
    fetch.mockResolvedValue(ok(RESULTS));
    const only2015 = await fetchSongs("rap", 2, { decade: "2010s" });
    expect(only2015.every((t) => t.releaseYear >= 2010 && t.releaseYear <= 2019)).toBe(true);

    // 1990s has zero matches -> falls back to the full pool rather than empty.
    clearCache();
    fetch.mockResolvedValue(ok(RESULTS));
    const fallback = await fetchSongs("rap", 3, { decade: "1990s" });
    expect(fallback.length).toBe(3);
  });

  it("caches by genre (one network call for repeated same-genre fetches)", async () => {
    fetch.mockResolvedValue(ok(RESULTS));
    await fetchSongs("rap", 3);
    await fetchSongs("rap", 3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prioritizes artist diversity in the sample", async () => {
    fetch.mockResolvedValue(ok(RESULTS));
    // Ann appears twice (tracks 1 and 6); a 3-pick sample should use 3 distinct
    // artists before repeating Ann.
    const out = await fetchSongs("rap", 3);
    const artists = out.map((t) => t.artistName);
    expect(new Set(artists).size).toBe(3);
  });

  it("falls back to stale cache on a network error", async () => {
    fetch.mockResolvedValueOnce(ok(RESULTS));
    await fetchSongs("rap", 3); // warm the cache
    fetch.mockRejectedValueOnce(new Error("network down"));
    const out = await fetchSongs("rap", 3);
    expect(out.length).toBe(3);
  });
});
