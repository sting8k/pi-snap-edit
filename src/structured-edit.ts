import { promises as fs } from "node:fs";
import { formatHash, hashLines, lineHash, parseAnchor } from "./anchors.js";
import { CONTEXT_LINES, formatContexts, formatDiffs, type ContextRange, type EditDiff } from "./diff.js";
import type { AnchorRangeInput, StructuredEditOp } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

function validateAnchorLine(lines: string[], anchorText: string, label: string): number {
  const anchor = parseAnchor(anchorText);
  if (!anchor) throw new Error(`${label}: invalid anchor '${anchorText}'`);
  const { line: lineNo, hash: expectedHash } = anchor;
  const total = lines.length;
  if (lineNo < 1 || lineNo > total) {
    throw new Error(`${label} line ${lineNo} out of bounds (file has ${total} lines)`);
  }

  const actualHash = lineHash(lines[lineNo - 1]!);
  if (actualHash !== expectedHash) {
    const contextStart = Math.max(0, lineNo - 3);
    const contextEnd = Math.min(total, lineNo + 2);
    throw new Error(
      `hash mismatch at ${label} line ${lineNo} (expected ${formatHash(expectedHash)}, got ${formatHash(actualHash)}):\n` +
        hashLines(lines.slice(contextStart, contextEnd), contextStart + 1),
    );
  }

  return lineNo;
}

function validateAnchorRange(lines: string[], range: AnchorRangeInput, label: string): { startLine: number; endLine: number } {
  const startLine = validateAnchorLine(lines, range.start, `${label} start`);
  const endLine = range.end ? validateAnchorLine(lines, range.end, `${label} end`) : startLine;
  if (endLine < startLine) {
    throw new Error(`Invalid ${label} range: ${startLine}-${endLine} (end < start)`);
  }
  return { startLine, endLine };
}

function countSubstring(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type AppliedLineEdit = { startLine: number; endLine: number; delta: number };

export async function applyStructuredEdits(
  absolutePath: string,
  ops: StructuredEditOp[],
  scope?: { start: string; end: string },
): Promise<string> {
  if (ops.length === 0) throw new Error("ops must contain at least one operation");

  const content = await fs.readFile(absolutePath, "utf8");
  const originalLines = splitLines(content);
  const currentLines = [...originalLines];
  const appliedLineEdits: AppliedLineEdit[] = [];
  const diffs: EditDiff[] = [];

  const scopeRange = scope ? validateAnchorRange(originalLines, scope, "scope") : undefined;

  const adjustedLine = (originalLine: number): number => {
    let adjusted = originalLine;
    for (const edit of appliedLineEdits) {
      if (originalLine >= edit.startLine && originalLine <= edit.endLine) {
        throw new Error(`anchor line ${originalLine} was already modified by an earlier structured_edit operation`);
      }
      if (originalLine > edit.endLine) adjusted += edit.delta;
    }
    return adjusted;
  };

  const applyLineReplacement = (range: AnchorRangeInput, newLines: string[], label: string) => {
    const { startLine, endLine } = validateAnchorRange(originalLines, range, label);
    const currentStart = adjustedLine(startLine);
    const currentEnd = adjustedLine(endLine);
    const oldLines = currentLines.slice(currentStart - 1, currentEnd);
    currentLines.splice(currentStart - 1, currentEnd - currentStart + 1, ...newLines);
    diffs.push({ oldStart: startLine, newStart: currentStart, oldLines, newLines });
    appliedLineEdits.push({ startLine, endLine, delta: newLines.length - (endLine - startLine + 1) });
  };

  const applyInsert = (anchor: string, insertedLines: string[], after: boolean, label: string) => {
    const lineNo = validateAnchorLine(originalLines, anchor, label);
    const currentLine = adjustedLine(lineNo);
    const insertIndex = after ? currentLine : currentLine - 1;
    currentLines.splice(insertIndex, 0, ...insertedLines);
    diffs.push({
      oldStart: after ? lineNo + 1 : lineNo,
      newStart: insertIndex + 1,
      oldLines: [],
      newLines: insertedLines,
    });
    appliedLineEdits.push({
      startLine: after ? lineNo + 1 : lineNo,
      endLine: after ? lineNo : lineNo - 1,
      delta: insertedLines.length,
    });
  };

  const applySubstitute = (op: Extract<StructuredEditOp, { type: "substitute" }>) => {
    if (op.old.length === 0) throw new Error("substitute old must not be empty");
    if (op.old.includes("\n") || op.old.includes("\r") || op.new.includes("\n") || op.new.includes("\r")) {
      throw new Error("substitute old/new must be single-line strings; use line operations for multi-line changes");
    }
    if (op.old === op.new) throw new Error("substitute old and new must differ");

    const expectedCount = op.count ?? 1;
    const currentStart = scopeRange ? adjustedLine(scopeRange.startLine) : 1;
    const currentEnd = scopeRange ? adjustedLine(scopeRange.endLine) : currentLines.length;

    let actualCount = 0;
    for (let i = currentStart - 1; i < currentEnd; i++) {
      actualCount += countSubstring(currentLines[i]!, op.old);
    }
    if (actualCount !== expectedCount) {
      throw new Error(
        `substitute expected ${expectedCount} occurrence(s) of ${JSON.stringify(op.old)} but found ${actualCount}` +
          (scopeRange ? " in scope" : ""),
      );
    }

    for (let i = currentStart - 1; i < currentEnd; i++) {
      const before = currentLines[i]!;
      const after = before.split(op.old).join(op.new);
      if (after !== before) {
        currentLines[i] = after;
        diffs.push({ oldStart: i + 1, newStart: i + 1, oldLines: [before], newLines: [after] });
      }
    }
  };

  for (const [i, op] of ops.entries()) {
    try {
      switch (op.type) {
        case "substitute":
          applySubstitute(op);
          break;
        case "replace_lines":
          applyLineReplacement(op.end ? { start: op.start, end: op.end } : { start: op.start }, op.lines, "replace_lines");
          break;
        case "delete_lines":
          applyLineReplacement(op.end ? { start: op.start, end: op.end } : { start: op.start }, [], "delete_lines");
          break;
        case "insert_before":
          applyInsert(op.anchor, op.lines, false, "insert_before");
          break;
        case "insert_after":
          applyInsert(op.anchor, op.lines, true, "insert_after");
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`op[${i}] ${op.type}: ${message}`);
    }
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = currentLines.join(lineEnding);
  if (hasTrailingNewline) newContent += lineEnding;
  if (newContent === content) throw new Error("structured_edit made no changes");

  await fs.writeFile(absolutePath, newContent, "utf8");

  const contextRanges: ContextRange[] = [];
  for (const diff of diffs) {
    const startIndex = Math.max(0, diff.newStart - 1 - CONTEXT_LINES);
    const newLineCount = Math.max(1, diff.newLines.length);
    const endIndex = Math.min(currentLines.length, diff.newStart - 1 + newLineCount + CONTEXT_LINES);
    contextRanges.push({ startIndex, endIndex });
  }

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  const contexts = formatContexts(currentLines, contextRanges);
  if (contexts) parts.push(contexts);
  return parts.join("\n\n") || "Structured edit applied.";
}
