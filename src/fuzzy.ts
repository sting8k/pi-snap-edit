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

/**
 * Multi-line target hint: when the target spans multiple lines and exact match
 * fails, show near matches for the first and last meaningful lines, plus anchor
 * block candidates where both the first and last lines match by trim (the middle
 * may differ). Diagnostic only — never auto-applied.
 */
type AnchorBlock = {
  startLine: number;
  endLine: number;
};

function findAnchorBlocks(lines: string[], firstLine: string, lastLine: string): AnchorBlock[] {
  const firstTrimmed = firstLine.trim();
  const lastTrimmed = lastLine.trim();

  // First line must be distinctive; last line can be short (e.g. `}`) since it is
  // found after the first line, making the combination specific enough.
  if (firstTrimmed.length < 4) return [];
  if (firstTrimmed === lastTrimmed) return [];

  const nextLastAtOrAfter: number[] = new Array(lines.length + 1).fill(-1);
  let nextLast = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === lastTrimmed) nextLast = i;
    nextLastAtOrAfter[i] = nextLast;
  }

  const blocks: AnchorBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== firstTrimmed) continue;
    const endIndex = nextLastAtOrAfter[i + 2] ?? -1;
    if (endIndex !== -1) blocks.push({ startLine: i + 1, endLine: endIndex + 1 });
    if (blocks.length >= 3) break;
  }
  return blocks;
}

export function formatMultiLineTargetHints(lines: string[], target: string): string {
  if (!target.includes("\n")) return "";

  const targetLines = target.split("\n").filter((line) => line.trim().length > 0);
  if (targetLines.length < 2) return "";

  const firstLine = targetLines[0]!;
  const lastLine = targetLines[targetLines.length - 1]!;

  const sections: string[] = [];

  const firstMatches = closeLineMatches(lines, firstLine);
  if (firstMatches.length > 0) {
    sections.push("first line near matches:");
    for (const m of firstMatches) sections.push(`  line ${m.lineNumber}: ${m.line.slice(0, 80)}`);
  }

  const lastMatches = closeLineMatches(lines, lastLine);
  if (lastMatches.length > 0) {
    sections.push("last line near matches:");
    for (const m of lastMatches) sections.push(`  line ${m.lineNumber}: ${m.line.slice(0, 80)}`);
  }

  const blocks = findAnchorBlocks(lines, firstLine, lastLine);
  if (blocks.length > 0) {
    const maxBlockLines = 10;
    sections.push("anchor block candidates (first/last line match by trim, middle differs):");
    for (const b of blocks) {
      const blockLines = lines.slice(b.startLine - 1, b.endLine);
      const width = String(b.endLine).length;
      sections.push(`  lines ${b.startLine}-${b.endLine}:`);
      if (blockLines.length <= maxBlockLines) {
        for (const [i, line] of blockLines.entries()) {
          sections.push(`    ${String(b.startLine + i).padStart(width, " ")}| ${line.slice(0, 80)}`);
        }
      } else {
        // Show first 3 + ellipsis + last 3 to cap output
        const head = 3;
        const tail = 3;
        for (const [i, line] of blockLines.slice(0, head).entries()) {
          sections.push(`    ${String(b.startLine + i).padStart(width, " ")}| ${line.slice(0, 80)}`);
        }
        sections.push(`    ${" ".repeat(width)}  ... (${blockLines.length - head - tail} lines omitted) ...`);
        for (const [i, line] of blockLines.slice(blockLines.length - tail).entries()) {
          sections.push(`    ${String(b.endLine - tail + i).padStart(width, " ")}| ${line.slice(0, 80)}`);
        }
      }
    }
  }

  return sections.length > 0 ? sections.join("\n") : "";
}
