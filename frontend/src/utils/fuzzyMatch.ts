/**
 * Utility for fuzzy string matching using Levenshtein distance and token similarity.
 * Used for auto-correcting voice AI typos and autocompleting party names.
 */

export function normalizeName(s: string): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

export function levenshteinDistance(a: string, b: string): number {
  const s1 = normalizeName(a);
  const s2 = normalizeName(b);

  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[s1.length][s2.length];
}

export function similarityScore(a: string, b: string): number {
  const s1 = normalizeName(a);
  const s2 = normalizeName(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  // Substring match bonus
  if (s1.includes(s2) || s2.includes(s1)) {
    // Containment used to score 0.8 no matter how little of the name matched, so
    // "cash" cleared the 0.65 threshold against "Cash & Carry Wholesalers" and
    // posted to the wrong party's ledger with no prompt. Mirror the length guard
    // the prefix path already applies; below that, fall back to the raw ratio.
    const shorter = Math.min(s1.length, s2.length);
    const longer = Math.max(s1.length, s2.length);
    const ratio = shorter / longer;
    return longer - shorter <= 4 ? Math.max(0.8, ratio) : ratio;
  }

  const dist = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - dist / maxLen;
}

export type CandidateParty = { id?: string; name: string; [key: string]: any };

/**
 * Finds the best matching existing party for a given input name (e.g. from Voice AI or typing).
 * Returns the candidate object if similarity score is above the threshold (default 0.65).
 */
export function findBestPartyMatch<T extends CandidateParty>(
  inputName: string,
  candidates: T[],
  threshold = 0.65
): T | null {
  const normInput = normalizeName(inputName);
  if (!normInput || !candidates.length) return null;

  // 1. Exact normalized match first
  const exact = candidates.find((c) => normalizeName(c.name) === normInput);
  if (exact) return exact;

  // 2. Prefix / Substring match
  const startsWithMatch = candidates.find(
    (c) => normalizeName(c.name).startsWith(normInput) || normInput.startsWith(normalizeName(c.name))
  );
  if (startsWithMatch && Math.abs(normalizeName(startsWithMatch.name).length - normInput.length) <= 4) {
    return startsWithMatch;
  }

  // 3. Fuzzy similarity score
  let bestMatch: T | null = null;
  let maxScore = 0;

  for (const candidate of candidates) {
    const score = similarityScore(inputName, candidate.name);
    if (score > maxScore && score >= threshold) {
      maxScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}
