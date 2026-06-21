// Lightweight, predictable profanity masking for guest handles and chat.
//
// This is deliberately simple: it tokenizes on non-alphanumerics, normalizes
// common leet substitutions, and masks any token whose normalized form is on a
// small blocklist. It will NOT catch every variant (embedded or creatively
// spaced) — it is a courtesy filter, not a guarantee. Keep expectations modest.

const BLOCKLIST = new Set([
  "fuck", "fucker", "fucking", "shit", "bitch", "cunt", "asshole", "dick",
  "pussy", "bastard", "slut", "whore", "nigger", "nigga", "faggot", "fag",
  "retard", "cum", "wank", "twat", "prick", "douche",
]);

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

function normalizeToken(tok) {
  let out = "";
  for (const ch of tok.toLowerCase()) out += LEET[ch] ?? ch;
  // Collapse repeated letters (fuuuuck -> fuck) so padding doesn't dodge it.
  return out.replace(/(.)\1{2,}/g, "$1$1").replace(/(.)\1+/g, "$1");
}

// Common inflections, so "fuckers"/"bitches"/"dicking" are caught from a single
// root in the blocklist. Stripped suffixes are re-checked against the blocklist.
const SUFFIXES = ["s", "es", "ed", "er", "ers", "ing", "in", "a", "y"];

// True if a single token (after normalization + de-suffixing) is profane.
function isBad(tok) {
  const n = normalizeToken(tok);
  if (BLOCKLIST.has(n)) return true;
  for (const suf of SUFFIXES) {
    if (n.length > suf.length + 1 && n.endsWith(suf) && BLOCKLIST.has(n.slice(0, -suf.length))) {
      return true;
    }
  }
  return false;
}

// True if any token in the text is profane.
export function containsProfanity(text) {
  const tokens = String(text ?? "").split(/[^a-zA-Z0-9@$!]+/);
  for (const t of tokens) {
    if (t && isBad(t)) return true;
  }
  return false;
}

// Replace any profane token with same-length asterisks, preserving the
// original separators/structure of the string.
export function maskProfanity(text) {
  const s = String(text ?? "");
  return s.replace(/[a-zA-Z0-9@$!]+/g, (tok) => (isBad(tok) ? "*".repeat(tok.length) : tok));
}

export default maskProfanity;
