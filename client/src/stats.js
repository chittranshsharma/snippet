// Local player profile stats (localStorage). Purely client-side — a lightweight
// "My profile" without accounts. (A server-backed global profile would live in
// storage.js behind DATABASE_URL.)

const KEY = "snippet.stats";
const EMPTY = { games: 0, wins: 0, bestScore: 0, correct: 0, rounds: 0 };

export function getStats() {
  try {
    return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) || "{}")) };
  } catch {
    return { ...EMPTY };
  }
}

export function recordGame({ won, score, correct, rounds }) {
  const s = getStats();
  const next = {
    games: s.games + 1,
    wins: s.wins + (won ? 1 : 0),
    bestScore: Math.max(s.bestScore, score || 0),
    correct: s.correct + (correct || 0),
    rounds: s.rounds + (rounds || 0),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked */
  }
  return next;
}

export default { getStats, recordGame };
