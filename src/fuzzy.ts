export type CloseLineMatch = {
  lineNumber: number;
  line: string;
  score: number;
};

export type CloseLineMatchOptions = {
  maxResults?: number;
  minScore?: number;
  maxLineLength?: number;
};

function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (value.length === 0) return counts;
  if (value.length === 1) {
    counts.set(value, 1);
    return counts;
  }

  for (let i = 0; i < value.length - 1; i++) {
    const gram = value.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function diceCoefficient(left: string, right: string): number {
  const leftCounts = bigramCounts(left);
  const rightCounts = bigramCounts(right);
  let leftTotal = 0;
  let rightTotal = 0;
  let shared = 0;

  for (const count of leftCounts.values()) leftTotal += count;
  for (const [gram, count] of rightCounts) {
    rightTotal += count;
    shared += Math.min(count, leftCounts.get(gram) ?? 0);
  }

  const total = leftTotal + rightTotal;
  return total === 0 ? 0 : (2 * shared) / total;
}

function similarityScore(needle: string, candidate: string): number {
  if (needle === candidate) return 1;
  if (needle.length === 0 || candidate.length === 0) return 0;

  const substringScore = needle.includes(candidate) || candidate.includes(needle)
    ? Math.min(needle.length, candidate.length) / Math.max(needle.length, candidate.length)
    : 0;
  return Math.max(substringScore, diceCoefficient(needle, candidate));
}

export function closeLineMatches(lines: string[], needle: string, options: CloseLineMatchOptions = {}): CloseLineMatch[] {
  if (needle.includes("\n") || needle.includes("\r")) return [];

  const maxResults = options.maxResults ?? 5;
  const minScore = options.minScore ?? 0.6;
  const maxLineLength = options.maxLineLength ?? 200;
  const normalizedNeedle = normalizeForSimilarity(needle).slice(0, maxLineLength);
  if (normalizedNeedle.length < 4) return [];

  return lines
    .map((line, index) => {
      const normalizedLine = normalizeForSimilarity(line).slice(0, maxLineLength);
      return { lineNumber: index + 1, line, score: similarityScore(normalizedNeedle, normalizedLine) };
    })
    .filter((match) => match.score >= minScore)
    .sort((left, right) => right.score - left.score || left.lineNumber - right.lineNumber)
    .slice(0, maxResults);
}

export function formatCloseLineMatches(lines: string[], needle: string, label = "close matches"): string {
  const matches = closeLineMatches(lines, needle);
  if (matches.length === 0) return "";
  return [label + ":", ...matches.map((match) => `  line ${match.lineNumber}: ${match.line.slice(0, 80)}`)].join("\n");
}
