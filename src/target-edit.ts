import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { formatCloseLineMatches } from "./fuzzy.js";
import type { TargetEditOp, TargetInsertBeforeOp, TargetInsertAfterOp } from "./schemas.js";
import { detectLineEnding, joinBom, splitBom, splitLines } from "./text.js";

type LineState = {
  lines: string[];
  trailingNewline: boolean;
};

type Occurrence = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
};

function toNormalized(state: LineState): string {
  const text = state.lines.join("\n");
  return state.trailingNewline && state.lines.length > 0 ? `${text}\n` : text;
}

function fromNormalized(text: string): LineState {
  return { lines: splitLines(text), trailingNewline: text.endsWith("\n") };
}

function toFileContent(state: LineState, lineEnding: "\r\n" | "\n"): string {
  const text = state.lines.join(lineEnding);
  return state.trailingNewline && state.lines.length > 0 ? `${text}${lineEnding}` : text;
}

function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function lineIndexAt(offsets: number[], lines: string[], offset: number): number {
  if (lines.length === 0) return 0;
  let index = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i]! <= offset) index = i;
    else break;
  }
  return Math.min(index, lines.length - 1);
}

function findOccurrences(text: string, target: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let index = text.indexOf(target);
  while (index !== -1) {
    occurrences.push({ start: index, end: index + target.length, startLine: 0, endLine: 0 });
    index = text.indexOf(target, index + target.length);
  }
  return occurrences;
}

function resolveOccurrenceLines(occurrences: Occurrence[], lines: string[], offsets: number[]): void {
  for (const occurrence of occurrences) {
    occurrence.startLine = lineIndexAt(offsets, lines, occurrence.start);
    occurrence.endLine = lineIndexAt(offsets, lines, Math.max(occurrence.end - 1, occurrence.start));
  }
}

function formatOccurrenceLines(occurrences: Occurrence[], lines: string[]): string {
  if (occurrences.length === 0) return "";
  const parts = occurrences.map((o) => `line ${o.startLine + 1}: ${lines[o.startLine]!.slice(0, 80)}`);
  return "\noccurrences:\n" + parts.map((p) => "  " + p).join("\n");
}
function validateLineSelector(line: unknown, lineCount: number, index: number): number {
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error(`op[${index}] line must be a 1-indexed line number`);
  }
  if (line > lineCount) {
    throw new Error(`op[${index}] line ${line} is out of bounds for file with ${lineCount} line(s)`);
  }
  return line - 1;
}

function selectedOccurrences(op: TargetEditOp, text: string, lines: string[], offsets: number[], index: number): Occurrence[] {
  if (op.target.length === 0) throw new Error(`op[${index}] target must not be empty`);
  if (op.target.includes("\r")) throw new Error(`op[${index}] target must use \\n line endings, not \\r`);

  const all = findOccurrences(text, op.target);
  if (all.length === 0) {
    const closeMatches = formatCloseLineMatches(lines, op.target, "close target matches");
    throw new Error([`op[${index}] target not found: ${JSON.stringify(op.target)}`, closeMatches].filter(Boolean).join("\n"));
  }
  resolveOccurrenceLines(all, lines, offsets);

  if (op.type === "insert_before" || op.type === "insert_after") {
    const targetLine = validateLineSelector(op.line, lines.length, index);
    const matches = all.filter((o) => o.startLine <= targetLine && o.endLine >= targetLine);
    if (matches.length === 0) {
      throw new Error(
        `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found 0` +
          formatOccurrenceLines(all, lines),
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found ${matches.length}` +
          formatOccurrenceLines(matches, lines),
      );
    }
    return [matches[0]!];
  }

  const hasLine = op.line !== undefined;
  const hasRange = op.range !== undefined;
  if (hasLine === hasRange) {
    throw new Error(`op[${index}] must provide exactly one of line or range`);
  }

  if (hasLine) {
    const targetLine = validateLineSelector(op.line, lines.length, index);
    const matches = all.filter((o) => o.startLine <= targetLine && o.endLine >= targetLine);
    if (matches.length === 0) {
      throw new Error(
        `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found 0` +
          formatOccurrenceLines(all, lines),
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found ${matches.length}` +
          formatOccurrenceLines(matches, lines),
      );
    }
    return [matches[0]!];
  }

  const range = op.range!;
  if (!Number.isInteger(range.startLine) || range.startLine < 1) {
    throw new Error(`op[${index}] range.startLine must be a 1-indexed line number`);
  }
  if (!Number.isInteger(range.endLine) || range.endLine < 1) {
    throw new Error(`op[${index}] range.endLine must be a 1-indexed line number`);
  }
  if (range.endLine < range.startLine) {
    throw new Error(`op[${index}] invalid range: lines ${range.startLine}-${range.endLine} (endLine < startLine)`);
  }
  if (range.startLine > lines.length || range.endLine > lines.length) {
    throw new Error(`op[${index}] range ${range.startLine}-${range.endLine} is out of bounds for file with ${lines.length} line(s)`);
  }
  const rangeStart = range.startLine - 1;
  const rangeEnd = range.endLine - 1;
  const matches = all.filter((o) => o.startLine >= rangeStart && o.endLine <= rangeEnd);
  if (matches.length === 0) {
    throw new Error(
      `op[${index}] expected occurrences of ${JSON.stringify(op.target)} in lines ${range.startLine}-${range.endLine} but found 0` +
        formatOccurrenceLines(all, lines),
    );
  }
  return matches;
}

function replaceRanges(text: string, occurrences: Occurrence[], replacement: string): string {
  let updated = text;
  for (const occurrence of [...occurrences].reverse()) {
    updated = `${updated.slice(0, occurrence.start)}${replacement}${updated.slice(occurrence.end)}`;
  }
  return updated;
}

function diffLines(before: string[], after: string[]): EditDiff | undefined {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldLines = before.slice(prefix, before.length - suffix);
  const newLines = after.slice(prefix, after.length - suffix);
  if (oldLines.length === 0 && newLines.length === 0) return undefined;
  return { oldStart: prefix + 1, newStart: prefix + 1, oldLines, newLines };
}

function contextForDiff(diff: EditDiff, lineCount: number): ContextRange | undefined {
  if (lineCount === 0) return undefined;
  const startIndex = Math.max(0, diff.newStart - 1 - CONTEXT_LINES);
  const changedCount = Math.max(1, diff.newLines.length);
  const endIndex = Math.min(lineCount, diff.newStart - 1 + changedCount + CONTEXT_LINES);
  return { startIndex, endIndex };
}

function rebasePriorDiffs(diffs: EditDiff[], shiftStartLine: number, delta: number): void {
  if (delta === 0) return;
  for (const diff of diffs) {
    if (diff.newStart >= shiftStartLine) {
      diff.oldStart += delta;
      diff.newStart += delta;
    }
  }
}

function unknownTypeError(op: TargetEditOp, index: number): Error {
  return new Error(`op[${index}] unknown type: ${JSON.stringify((op as { type?: unknown }).type)}`);
}

function validatePayload(op: TargetEditOp, index: number): void {
  if (op.type !== "replace" && op.type !== "delete" && op.type !== "insert_before" && op.type !== "insert_after") {
    throw unknownTypeError(op, index);
  }
  if (op.type === "replace") {
    if (op.replacement.includes("\r")) throw new Error(`op[${index}] replacement must use \\n line endings, not \\r`);
    if (op.replacement === op.target) throw new Error(`op[${index}] replacement must differ from target`);
  }
  if (op.type === "insert_before" || op.type === "insert_after") {
    if (op.lines.length === 0) throw new Error(`op[${index}] lines must contain at least one line`);
    for (const [lineIndex, line] of op.lines.entries()) {
      if (line.includes("\n") || line.includes("\r")) throw new Error(`op[${index}] lines[${lineIndex}] must not contain line endings`);
    }
  }
}

function applyInsert(
  state: LineState,
  occurrences: Occurrence[],
  op: TargetInsertBeforeOp | TargetInsertAfterOp,
): LineState {
  const lines = [...state.lines];
  for (const occurrence of [...occurrences].sort((a, b) => b.startLine - a.startLine)) {
    const insertIndex = op.type === "insert_before" ? occurrence.startLine : occurrence.endLine + 1;
    lines.splice(insertIndex, 0, ...op.lines);
  }
  return { lines, trailingNewline: state.trailingNewline };
}

export async function applyTargetEdits(
  absolutePath: string,
  ops: TargetEditOp[],
): Promise<string> {
  if (ops.length === 0) throw new Error("ops must contain at least one target edit");

  const content = await fs.readFile(absolutePath, "utf8");
  const source = splitBom(content);
  const lineEnding = detectLineEnding(source.text);
  let state: LineState = { lines: splitLines(source.text), trailingNewline: source.text.endsWith("\n") };
  const diffs: EditDiff[] = [];

  for (const [index, op] of ops.entries()) {
    validatePayload(op, index);
    const beforeLines = state.lines;
    const text = toNormalized(state);
    const offsets = lineStartOffsets(state.lines);
    const occurrences = selectedOccurrences(op, text, state.lines, offsets, index);

    switch (op.type) {
      case "insert_before":
      case "insert_after":
        state = applyInsert(state, occurrences, op);
        break;
      case "replace":
        state = fromNormalized(replaceRanges(text, occurrences, op.replacement));
        break;
      case "delete":
        state = fromNormalized(replaceRanges(text, occurrences, ""));
        break;
      default:
        throw unknownTypeError(op, index);
    }

    const diff = diffLines(beforeLines, state.lines);
    if (diff) {
      rebasePriorDiffs(diffs, diff.newStart, diff.newLines.length - diff.oldLines.length);
      diffs.push(diff);
    }
  }

  await fs.writeFile(absolutePath, joinBom(toFileContent(state, lineEnding), source.bom), "utf8");

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  const contextRanges = diffs.flatMap((diff) => {
    const range = contextForDiff(diff, state.lines.length);
    return range ? [range] : [];
  });
  const contexts = formatContexts(state.lines, contextRanges);
  if (contexts) parts.push(contexts);
  return parts.join("\n\n");
}
