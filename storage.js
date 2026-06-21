// Optional persistent storage (Postgres) for a GLOBAL leaderboard + match
// history. Completely dormant unless DATABASE_URL is set AND the `pg` package is
// installed on the host (it is NOT a hard dependency). Every failure is
// swallowed so the live game never breaks because of the database.
//
// Enable: `npm install pg` on the backend host and set DATABASE_URL (Railway's
// Postgres add-on provides one). See DEPLOY.md.

let pool = null;
let ready = false;

export async function initStorage(log) {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scores (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sub TEXT,
        score INTEGER NOT NULL,
        rounds INTEGER NOT NULL,
        mode TEXT,
        genre TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    ready = true;
    log?.info?.("postgres storage ready (global leaderboard enabled)");
    return true;
  } catch (e) {
    log?.warn?.("DATABASE_URL set but storage init failed; run `npm install pg` or check the URL", {
      error: String((e && e.message) || e),
    });
    return false;
  }
}

export function storageReady() {
  return ready;
}

// Persist each non-spectator player's final score for a finished match.
export async function recordMatch({ players, settings }, log) {
  if (!ready || !pool) return;
  try {
    for (const p of players) {
      if (p.spectator) continue;
      await pool.query(
        "INSERT INTO scores(name, sub, score, rounds, mode, genre) VALUES($1,$2,$3,$4,$5,$6)",
        [p.name, p.sub || null, p.score, settings.rounds, settings.mode, settings.genre]
      );
    }
  } catch (e) {
    log?.warn?.("recordMatch failed", { error: String((e && e.message) || e) });
  }
}

// Global top scores (each player's best single-match score).
export async function topScores(limit = 20) {
  if (!ready || !pool) return [];
  try {
    const res = await pool.query(
      "SELECT name, MAX(score) AS score FROM scores GROUP BY name ORDER BY score DESC LIMIT $1",
      [Math.min(100, Math.max(1, Number(limit) || 20))]
    );
    return res.rows.map((r, i) => ({ rank: i + 1, name: r.name, score: Number(r.score) }));
  } catch {
    return [];
  }
}

export default { initStorage, storageReady, recordMatch, topScores };
