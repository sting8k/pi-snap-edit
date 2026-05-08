import { formatHash, hashLines, lineHash } from "./anchors.js";

export const CONTEXT_LINES = 5;

export type EditDiff = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

export type ContextRange = {
  startIndex: number;
  endIndex: number;
};

export function formatContexts(lines: string[], ranges: ContextRange[]): string {
  const ordered = ranges
    .filter((range) => range.startIndex < range.endIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  const merged: ContextRange[] = [];

  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => hashLines(lines.slice(range.startIndex, range.endIndex), range.startIndex + 1)).join("\n---\n");
}

function hashCounts(lines: string[]): { hashes: string[]; counts: Map<string, number> } {
  const hashes = lines.map((line) => formatHash(lineHash(line)));
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return { hashes, counts };
}

function displayedHash(hash: string, counts: Map<string, number>): string {
  return counts.get(hash) === 1 ? hash : "-----";
}

export function formatDiffs(diffs: EditDiff[]): string {
  if (diffs.length === 0) return "";
  const chunks: string[] = ["── diff ──"];

  for (const diff of diffs) {
    const oldEnd = diff.oldStart + Math.max(0, diff.oldLines.length - 1);
    if (diff.oldLines.length <= 1 && diff.newLines.length <= 1) {
      chunks.push(`:${diff.oldStart}`);
    } else {
      const newEnd = diff.newStart + Math.max(0, diff.newLines.length - 1);
      chunks.push(`:${diff.oldStart}-${Math.max(oldEnd, newEnd)}`);
    }

    const old = hashCounts(diff.oldLines);
    const next = hashCounts(diff.newLines);

    for (let i = 0; i < diff.oldLines.length; i++) {
      const line = diff.oldLines[i]!;
      chunks.push(`- ${displayedHash(old.hashes[i]!, old.counts)}|${line}`);
    }
    for (let i = 0; i < diff.newLines.length; i++) {
      const line = diff.newLines[i]!;
      chunks.push(`+ ${displayedHash(next.hashes[i]!, next.counts)}|${line}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}
