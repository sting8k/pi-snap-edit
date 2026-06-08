import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { getFileStatSnapshot } from "./file-stat.js";
import { formatCloseLineMatches } from "./fuzzy.js";
import type { Edit } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

type ResolvedEdit = {
  startLine: number;
  endLine: number;
  lines: string[];
  insert: boolean;
};
type ExpectedStartLineMatch = NonNullable<Edit["expectedStartLineMatch"]>;

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

function expectedLineMatchMode(edit: Edit, label: string): ExpectedStartLineMatch {
  const mode = edit.expectedStartLineMatch ?? "exact";
  if (mode !== "exact" && mode !== "trim") throw new Error(`${label} expectedStartLineMatch must be "exact" or "trim"`);
  return mode;
}

function expectedLineMatches(actual: string, expectedStartLine: string, mode: ExpectedStartLineMatch): boolean {
  return mode === "trim" ? actual.trim() === expectedStartLine.trim() : actual === expectedStartLine;
}

function leadingIndent(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

function withPreservedIndent(lines: string[], indent: string): string[] {
  return lines.map((line) => line === "" ? line : `${indent}${line}`);
}

function matchingLineNumbers(lines: string[], expectedStartLine: string, mode: ExpectedStartLineMatch): number[] {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (expectedLineMatches(lines[i]!, expectedStartLine, mode)) matches.push(i + 1);
  }
  return matches;
}

function formatExpectedLineMatches(lines: string[], matches: number[], label: string, hint?: string): string {
  const shown = matches.slice(0, 5);
  const ranges = shown.map((lineNumber) => ({
    startIndex: Math.max(0, lineNumber - 1 - CONTEXT_LINES),
    endIndex: Math.min(lines.length, lineNumber + CONTEXT_LINES),
  }));
  const suffix = matches.length > shown.length ? ` (showing first ${shown.length} of ${matches.length})` : "";
  return [
    `${label}: ${shown.join(", ")}${suffix}.`,
    hint,
    formatContexts(lines, ranges),
  ].filter(Boolean).join("\n");
}

function expectedLineHint(lines: string[], expectedStartLine: string, mode: ExpectedStartLineMatch): string {
  const matches = matchingLineNumbers(lines, expectedStartLine, mode);
  if (matches.length > 0) return formatExpectedLineMatches(lines, matches, "Expected start line found at line(s)");

  if (mode === "exact") {
    const trimMatches = matchingLineNumbers(lines, expectedStartLine, "trim");
    if (trimMatches.length > 0) {
      return formatExpectedLineMatches(
        lines,
        trimMatches,
        "Expected start line matched by trim at line(s)",
        "hint: use expectedStartLineMatch=\"trim\" if whitespace differs.",
      );
    }
  }

  const closeMatches = formatCloseLineMatches(lines, expectedStartLine, "Close start-line matches");
  return closeMatches ? `${closeMatches}\nhint: use expectedStartLineMatch=\"trim\" if whitespace differs.` : "";
}

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");


  const content = await fs.readFile(absolutePath, "utf8");
  const lines = splitLines(content);
  const resolved = edits.map((edit, index) => validateLineRange(lines.length, edit, `edit[${index}]`));

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const expectedStartLine = edit.expectedStartLine;
    const matchMode = expectedLineMatchMode(edit, `edit[${index}]`);
    const resolvedEdit = resolved[index]!;

    const actual = lines[resolvedEdit.startLine - 1] ?? "";
    if (!expectedLineMatches(actual, expectedStartLine, matchMode)) {
      const hint = expectedLineHint(lines, expectedStartLine, matchMode);
      throw new Error(
        [
          `edit[${index}] expectedStartLine mismatch at line ${resolvedEdit.startLine}; no edits were applied.`,
          hint || "Read the file to see current content.",
        ].join("\n"),
      );
    }

    if (edit.preserveIndent) resolvedEdit.lines = withPreservedIndent(resolvedEdit.lines, leadingIndent(actual));
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
