import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { getFileStatSnapshot } from "./file-stat.js";
import type { Edit } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

type ResolvedEdit = {
  startLine: number;
  endLine: number;
  lines: string[];
  insert: boolean;
};

function validateLineRange(lineCount: number, edit: Edit, label: string): ResolvedEdit {
  const startLine = edit.start;
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error(`${label} start must be a 1-indexed line number`);

  if (edit.end === undefined && startLine === lineCount + 1) {
    if (edit.lines.length === 0) throw new Error(`${label} EOF insert must include at least one line`);
    return { startLine, endLine: startLine, lines: edit.lines, insert: true };
  }

  const endLine = edit.end ?? startLine;
  if (!Number.isInteger(endLine) || endLine < 1) throw new Error(`${label} end must be a 1-indexed line number`);
  if (endLine < startLine) throw new Error(`${label} invalid range: lines ${startLine}-${endLine} (end < start)`);
  if (startLine > lineCount || endLine > lineCount) {
    throw new Error(`${label} range ${startLine}-${endLine} is out of bounds for file with ${lineCount} line(s)`);
  }

  return { startLine, endLine, lines: edit.lines, insert: false };
}

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");


  const content = await fs.readFile(absolutePath, "utf8");
  const lines = splitLines(content);
  const resolved = edits.map((edit, index) => validateLineRange(lines.length, edit, `edit[${index}]`));

  for (let index = 0; index < edits.length; index++) {
    const expectedStartLine = edits[index]!.expectedStartLine;

    const actual = lines[resolved[index]!.startLine - 1] ?? "";
    if (actual !== expectedStartLine) {
      throw new Error(
        [
          `edit[${index}] expectedStartLine mismatch at line ${resolved[index]!.startLine}; no edits were applied.`,
          "Read the file to see current content.",
        ].join("\n"),
      );
    }
  }

  const ranges = resolved.map((edit) => [edit.startLine, edit.endLine] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const curr = ranges[i]!;
    if (prev[1] >= curr[0]) {
      throw new Error(`overlapping edit ranges in batch: lines ${prev[0]}-${prev[1]} and ${curr[0]}-${curr[1]}`);
    }
  }

  const oldSnapshots = resolved.map((edit) => edit.insert ? [] : lines.slice(edit.startLine - 1, edit.endLine));
  const updated = [...lines];
  const indices = resolved.map((_, i) => i).sort((a, b) => resolved[b]!.startLine - resolved[a]!.startLine);

  for (const idx of indices) {
    const edit = resolved[idx]!;
    updated.splice(edit.startLine - 1, edit.insert ? 0 : edit.endLine - edit.startLine + 1, ...edit.lines);
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline && updated.length > 0) newContent += lineEnding;
  await fs.writeFile(absolutePath, newContent, "utf8");

  const ordered = resolved.map((_, i) => i).sort((a, b) => resolved[a]!.startLine - resolved[b]!.startLine);
  let offset = 0;
  const contextRanges: ContextRange[] = [];
  const diffs: EditDiff[] = [];

  for (const idx of ordered) {
    const edit = resolved[idx]!;
    const adjusted = Math.max(0, edit.startLine - 1 + offset);
    const oldCount = edit.insert ? 0 : edit.endLine - edit.startLine + 1;
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
  return parts.join("\n\n");
}
