import { promises as fs } from "node:fs";
import { formatHash, hashLines, lineHash } from "./anchors.js";
import { CONTEXT_LINES, formatContexts, formatDiffs, type ContextRange, type EditDiff } from "./diff.js";
import type { Edit } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");

  const content = await fs.readFile(absolutePath, "utf8");
  const lines = splitLines(content);
  const total = lines.length;
  const mismatches: string[] = [];

  for (const edit of edits) {
    if (edit.startLine < 1 || edit.startLine > total) {
      mismatches.push(`Line ${edit.startLine} out of bounds (file has ${total} lines)`);
      continue;
    }
    if (edit.endLine < 1 || edit.endLine > total) {
      mismatches.push(`Line ${edit.endLine} out of bounds (file has ${total} lines)`);
      continue;
    }
    if (edit.endLine < edit.startLine) {
      mismatches.push(`Invalid range: ${edit.startLine}-${edit.endLine} (end < start)`);
      continue;
    }

    const startIndex = edit.startLine - 1;
    const actualStartHash = lineHash(lines[startIndex]!);
    if (actualStartHash !== edit.startHash) {
      const contextStart = Math.max(0, startIndex - 2);
      const contextEnd = Math.min(total, startIndex + 3);
      mismatches.push(
        `Hash mismatch at line ${edit.startLine} (expected ${formatHash(edit.startHash)}, got ${formatHash(actualStartHash)}):\n` +
          hashLines(lines.slice(contextStart, contextEnd), contextStart + 1),
      );
      continue;
    }

    if (edit.endLine !== edit.startLine) {
      const endIndex = edit.endLine - 1;
      const actualEndHash = lineHash(lines[endIndex]!);
      if (actualEndHash !== edit.endHash) {
        const contextStart = Math.max(0, endIndex - 2);
        const contextEnd = Math.min(total, endIndex + 3);
        mismatches.push(
          `Hash mismatch at line ${edit.endLine} (expected ${formatHash(edit.endHash)}, got ${formatHash(actualEndHash)}):\n` +
            hashLines(lines.slice(contextStart, contextEnd), contextStart + 1),
        );
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`hash mismatch — file changed since last read:\n\n${mismatches.join("\n\n")}`);
  }

  const ranges = edits.map((edit) => [edit.startLine, edit.endLine] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const curr = ranges[i]!;
    if (prev[1] >= curr[0]) {
      throw new Error(`overlapping edit ranges in batch: lines ${prev[0]}-${prev[1]} and ${curr[0]}-${curr[1]}`);
    }
  }

  const oldSnapshots = edits.map((edit) => lines.slice(edit.startLine - 1, edit.endLine));
  const updated = [...lines];
  const indices = edits.map((_, i) => i).sort((a, b) => edits[b]!.startLine - edits[a]!.startLine);

  for (const idx of indices) {
    const edit = edits[idx]!;
    const replacement = edit.lines;
    updated.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement);
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline) newContent += lineEnding;
  await fs.writeFile(absolutePath, newContent, "utf8");

  const ordered = edits.map((_, i) => i).sort((a, b) => edits[a]!.startLine - edits[b]!.startLine);
  let offset = 0;
  const contextRanges: ContextRange[] = [];
  const diffs: EditDiff[] = [];

  for (const idx of ordered) {
    const edit = edits[idx]!;
    const adjusted = Math.max(0, edit.startLine - 1 + offset);
    const oldCount = edit.endLine - edit.startLine + 1;
    const newLines = edit.lines;
    const newStart = Math.max(1, adjusted + 1);

    diffs.push({ oldStart: edit.startLine, newStart, oldLines: oldSnapshots[idx]!, newLines });

    const contextStart = Math.max(0, adjusted - CONTEXT_LINES);
    const contextEnd = Math.min(updated.length, adjusted + newLines.length + CONTEXT_LINES);
    contextRanges.push({ startIndex: contextStart, endIndex: contextEnd });

    offset += newLines.length - oldCount;
  }

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  const contexts = formatContexts(updated, contextRanges);
  if (contexts) parts.push(contexts);
  return parts.join("\n\n") || "Edits applied.";
}
