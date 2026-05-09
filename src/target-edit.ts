import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import type { TargetEditOp, TargetEditScopeInput } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

type LineState = {
  lines: string[];
  trailingNewline: boolean;
};

type Occurrence = {
  start: number;
  end: number;
};

type ScopeRange = {
  start: number;
  end: number;
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

function validateScope(lines: string[], textLength: number, scope: TargetEditScopeInput | undefined): ScopeRange {
  if (scope === undefined) return { start: 0, end: textLength };
  const { startLine, endLine } = scope;
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error("scope.startLine must be a 1-indexed line number");
  if (!Number.isInteger(endLine) || endLine < 1) throw new Error("scope.endLine must be a 1-indexed line number");
  if (endLine < startLine) throw new Error(`invalid scope: lines ${startLine}-${endLine} (endLine < startLine)`);
  if (startLine > lines.length || endLine > lines.length) {
    throw new Error(`scope ${startLine}-${endLine} is out of bounds for file with ${lines.length} line(s)`);
  }

  const offsets = lineStartOffsets(lines);
  return {
    start: offsets[startLine - 1]!,
    end: offsets[endLine - 1]! + lines[endLine - 1]!.length,
  };
}

function findOccurrences(text: string, target: string, scope: ScopeRange): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let index = text.indexOf(target, scope.start);
  while (index !== -1 && index + target.length <= scope.end) {
    occurrences.push({ start: index, end: index + target.length });
    index = text.indexOf(target, index + target.length);
  }
  return occurrences;
}

function selectedOccurrences(op: TargetEditOp, text: string, scope: ScopeRange, index: number): Occurrence[] {
  const hasOccurrence = op.occurrence !== undefined;
  const hasCount = op.count !== undefined;
  if (hasOccurrence === hasCount) throw new Error(`op[${index}] must provide exactly one of occurrence or count`);
  if (op.target.length === 0) throw new Error(`op[${index}] target must not be empty`);
  if (op.target.includes("\r")) throw new Error(`op[${index}] target must use \n line endings, not \r`);

  const occurrences = findOccurrences(text, op.target, scope);
  if (hasOccurrence) {
    const occurrence = op.occurrence!;
    if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error(`op[${index}] occurrence must be a positive integer`);
    const match = occurrences[occurrence - 1];
    if (match === undefined) {
      throw new Error(`op[${index}] expected occurrence ${occurrence} of ${JSON.stringify(op.target)} but found ${occurrences.length}`);
    }
    return [match];
  }

  const count = op.count!;
  if (!Number.isInteger(count) || count < 1) throw new Error(`op[${index}] count must be a positive integer`);
  if (occurrences.length !== count) {
    throw new Error(`op[${index}] expected ${count} occurrence(s) of ${JSON.stringify(op.target)} but found ${occurrences.length}`);
  }
  return occurrences;
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

function validatePayload(op: TargetEditOp, index: number): void {
  if (op.type === "replace") {
    if (op.replacement.includes("\r")) throw new Error(`op[${index}] replacement must use \n line endings, not \r`);
    if (op.replacement === op.target) throw new Error(`op[${index}] replacement must differ from target`);
  }
  if (op.type === "insert") {
    if (op.lines.length === 0) throw new Error(`op[${index}] lines must contain at least one line`);
    for (const [lineIndex, line] of op.lines.entries()) {
      if (line.includes("\n") || line.includes("\r")) throw new Error(`op[${index}] lines[${lineIndex}] must not contain line endings`);
    }
  }
}

function applyInsert(state: LineState, occurrences: Occurrence[], op: Extract<TargetEditOp, { type: "insert" }>): LineState {
  const offsets = lineStartOffsets(state.lines);
  const insertions = occurrences.map((occurrence) => {
    const startLine = lineIndexAt(offsets, state.lines, occurrence.start);
    const endLine = lineIndexAt(offsets, state.lines, Math.max(occurrence.end - 1, occurrence.start));
    return op.position === "before" ? startLine : endLine + 1;
  });

  const lines = [...state.lines];
  for (const lineIndex of [...insertions].sort((a, b) => b - a)) {
    lines.splice(lineIndex, 0, ...op.lines);
  }
  return { lines, trailingNewline: state.trailingNewline };
}

export async function applyTargetEdits(
  absolutePath: string,
  ops: TargetEditOp[],
  scope?: TargetEditScopeInput,
): Promise<string> {
  if (ops.length === 0) throw new Error("ops must contain at least one target edit");

  const content = await fs.readFile(absolutePath, "utf8");
  const lineEnding = detectLineEnding(content);
  let state: LineState = { lines: splitLines(content), trailingNewline: content.endsWith("\n") };
  const diffs: EditDiff[] = [];

  for (const [index, op] of ops.entries()) {
    validatePayload(op, index);
    const beforeLines = state.lines;
    const text = toNormalized(state);
    const range = validateScope(state.lines, text.length, scope);
    const occurrences = selectedOccurrences(op, text, range, index);

    if (op.type === "insert") {
      state = applyInsert(state, occurrences, op);
    } else {
      const replacement = op.type === "replace" ? op.replacement : "";
      state = fromNormalized(replaceRanges(text, occurrences, replacement));
    }

    const diff = diffLines(beforeLines, state.lines);
    if (diff) {
      rebasePriorDiffs(diffs, diff.newStart, diff.newLines.length - diff.oldLines.length);
      diffs.push(diff);
    }
  }

  await fs.writeFile(absolutePath, toFileContent(state, lineEnding), "utf8");

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
