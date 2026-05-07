import { formatHash, lineHash } from "./anchors.js";

export const CONTEXT_LINES = 5;

export type EditDiff = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

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

    for (let i = 0; i < diff.oldLines.length; i++) {
      const lineNo = diff.oldStart + i;
      const line = diff.oldLines[i]!;
      chunks.push(`- ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    for (let i = 0; i < diff.newLines.length; i++) {
      const lineNo = diff.newStart + i;
      const line = diff.newLines[i]!;
      chunks.push(`+ ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}
