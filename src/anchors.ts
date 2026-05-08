import { createHash } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HASH_PATTERN = "[A-Z2-7]{5}";

export type Anchor = {
  hash: string;
};

export function lineHash(line: string): string {
  const digest = createHash("sha256").update(line, "utf8").digest();
  const value = (digest[0]! << 17) | (digest[1]! << 9) | (digest[2]! << 1) | (digest[3]! >>> 7);
  let hash = "";
  for (let shift = 20; shift >= 0; shift -= 5) hash += BASE32[(value >>> shift) & 31]!;
  return hash;
}

export function formatHash(hash: string): string {
  return hash;
}

export function hashLines(lines: string[], _startLine: number, hiddenHashes: ReadonlySet<string> = new Set()): string {
  const hashes = lines.map((line) => formatHash(lineHash(line)));
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);

  return lines
    .map((line, i) => {
      const hash = hashes[i]!;
      return `${hiddenHashes.has(hash) || counts.get(hash) !== 1 ? "-----" : hash}|${line}`;
    })
    .join("\n");
}

function hiddenHashesFor(lines: string[], extra: Iterable<string> = []): Set<string> {
  const allHashes = lines.map((line) => formatHash(lineHash(line)));
  const allCounts = new Map<string, number>();
  for (const currentHash of allHashes) allCounts.set(currentHash, (allCounts.get(currentHash) ?? 0) + 1);

  const hiddenHashes = new Set(extra);
  for (const [currentHash, count] of allCounts) {
    if (count > 1) hiddenHashes.add(currentHash);
  }
  return hiddenHashes;
}

function formatLineContexts(lines: string[], lineNumbers: number[], hiddenHashes: ReadonlySet<string>, label: (index: number, lineNo: number) => string): string {
  if (lineNumbers.length === 0 || lineNumbers.length > 10) return "";

  return lineNumbers
    .map((lineNo, i) => {
      const index = lineNo - 1;
      const startIndex = Math.max(0, index - 2);
      const endIndex = Math.min(lines.length, index + 3);
      return `${label(i, lineNo)}\n${hashLines(lines.slice(startIndex, endIndex), startIndex + 1, hiddenHashes)}`;
    })
    .join("\n---\n");
}

export function formatAmbiguousAnchorCandidates(lines: string[], matches: number[], hash: string): string {
  return formatLineContexts(lines, matches, hiddenHashesFor(lines, [hash]), (_i, lineNo) => `@@ line ${lineNo}`);
}

export function formatOccurrenceContexts(lines: string[], occurrenceLines: number[]): string {
  return formatLineContexts(
    lines,
    occurrenceLines,
    hiddenHashesFor(lines),
    (index, lineNo) => `@@ occurrence ${index + 1} line ${lineNo}`,
  );
}

export function parseAnchor(anchor: string): Anchor | undefined {
  const text = anchor.trim();
  const hashOnly = new RegExp(`^${HASH_PATTERN}$`, "i");
  return hashOnly.test(text) ? { hash: text.toUpperCase() } : undefined;
}

export function invalidAnchorMessage(anchor: string): string {
  const prefix = anchor.split("|", 1)[0] ?? "";
  if (anchor.includes("|") && parseAnchor(prefix)) {
    return `invalid anchor '${anchor}'. Use only '${prefix}' before '|'.`;
  }
  return `invalid anchor '${anchor}'. Expected '<hash>', e.g. 'ABCDE'.`;
}
