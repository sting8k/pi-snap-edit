import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { throwEditError, type EditFailureCandidate } from "./edit-error.js";
import { closeLineMatches, formatCloseLineMatches, formatMultiLineTargetHints } from "./fuzzy.js";
import { unescapeLiteralSequences } from "./match-helpers.js";
import type { TargetEditOp, TargetInsertBeforeOp, TargetInsertAfterOp } from "./schemas.js";
import { bytePropertiesNote, detectLineEnding, joinBom, splitBom, splitLines } from "./text.js";

type LineState = {
  lines: string[];
  trailingNewline: boolean;
};

type IndentAdjustment =
  | { kind: "add"; whitespace: string }
  | { kind: "remove"; whitespace: string }
  | { kind: "none" };

type Occurrence = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  kind: "raw" | "fallback" | "trimmed" | "trimmed-unescaped";
  indent?: IndentAdjustment;
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

type TargetOccurrences = {
  raw: Occurrence[];
  fallback: Occurrence[];
  trimmed: Occurrence[];
};

function findNeedleOccurrences(text: string, needle: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    occurrences.push({ start: index, end: index + needle.length, startLine: 0, endLine: 0, kind: "raw" });
    index = text.indexOf(needle, index + Math.max(1, needle.length));
  }
  return occurrences;
}

type LineWithOffset = {
  text: string;
  start: number;
  end: number;
};

function splitLinesWithOffsets(text: string): LineWithOffset[] {
  const lines: LineWithOffset[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lines.push({ text: text.slice(start, i), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), start, end: text.length });
  }
  return lines;
}

function trimLeadingLength(s: string): number {
  return s.length - s.trimStart().length;
}

function trimTrailingLength(s: string): number {
  return s.length - s.trimEnd().length;
}

function trimmedTargetLines(target: string): string[] {
  const targetLines = target.split("\n");
  // Ignore leading and trailing empty/whitespace-only lines that often come
  // from copying a block with a leading blank line or its terminating newline.
  // Trim matching is meant to be whitespace-tolerant at the block edges, so an
  // edge blank line should not break the match. Lines strictly inside the
  // target still match literally.
  while (targetLines.length > 1 && targetLines[targetLines.length - 1]!.trim() === "") {
    targetLines.pop();
  }
  while (targetLines.length > 1 && targetLines[0]!.trim() === "") {
    targetLines.shift();
  }
  return targetLines;
}

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

function getIndentAdjustment(expectedLines: string[], actualLines: string[]): IndentAdjustment | undefined {
  // Uniform indentation delta between the target (as the caller wrote it) and
  // the matched file lines. Every non-blank line pair must share the same kind
  // and the same whitespace string; otherwise the drift is non-uniform and no
  // adjustment applies (callers fall back to today's literal replacement).
  let adjustment: IndentAdjustment | undefined;
  for (let i = 0; i < expectedLines.length; i++) {
    if (expectedLines[i]!.trim() === "") continue;
    const expected = leadingWhitespace(expectedLines[i]!);
    const actual = leadingWhitespace(actualLines[i]!);
    const current =
      actual === expected
        ? { kind: "none" as const }
        : actual.endsWith(expected)
          ? { kind: "add" as const, whitespace: actual.slice(0, actual.length - expected.length) }
          : expected.endsWith(actual)
            ? { kind: "remove" as const, whitespace: expected.slice(0, expected.length - actual.length) }
            : undefined;
    if (!current) return undefined;
    if (!adjustment) {
      adjustment = current;
    } else if (
      adjustment.kind !== current.kind ||
      (adjustment.kind !== "none" && current.kind !== "none" && adjustment.whitespace !== current.whitespace)
    ) {
      return undefined;
    }
  }
  return adjustment ?? { kind: "none" };
}

function hasMeaningfulTrimTarget(target: string): boolean {
  return trimmedTargetLines(target).some((line) => line.trim().length > 0);
}

function findTrimmedOccurrences(text: string, target: string): Occurrence[] {
  const targetLines = trimmedTargetLines(target);
  const targetLineCount = targetLines.length;
  if (targetLineCount === 0 || !targetLines.some((line) => line.trim().length > 0)) return [];

  const textLines = splitLinesWithOffsets(text);
  const occurrences: Occurrence[] = [];

  for (let i = 0; i <= textLines.length - targetLineCount; i++) {
    let matches = true;
    for (let j = 0; j < targetLineCount; j++) {
      if (textLines[i + j]!.text.trim() !== targetLines[j]!.trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      // Bound the occurrence to the trimmed content so that original indentation
      // and line endings are preserved on replace/delete.
      const firstLine = textLines[i]!;
      const lastLine = textLines[i + targetLineCount - 1]!;
      const start = firstLine.start + trimLeadingLength(firstLine.text);
      // Exclude the terminating newline (if any) so the occurrence does not
      // consume the line ending of the last matched line.
      const hasNewline = lastLine.end > 0 && text[lastLine.end - 1] === "\n";
      const contentEnd = lastLine.end - (hasNewline ? 1 : 0);
      const end = Math.max(start, contentEnd - trimTrailingLength(lastLine.text));
      const indent = getIndentAdjustment(
        targetLines,
        textLines.slice(i, i + targetLineCount).map((line) => line.text),
      );
      occurrences.push({
        start,
        end,
        startLine: 0,
        endLine: 0,
        kind: "trimmed",
        ...(indent !== undefined ? { indent } : {}),
      });
    }
  }
  return occurrences;
}

function findTargetOccurrences(text: string, target: string, matchMode: "exact" | "trim" = "exact"): TargetOccurrences {
  if (matchMode === "trim") {
    // In trim mode we do line-level whitespace-tolerant matching. Ignore exact
    // substring matches so that a target like "bar();" doesn't accidentally match
    // inside an indented line and change the effective column.
    const trimmed = findTrimmedOccurrences(text, target);
    const unescaped = unescapeLiteralSequences(target);
    const fallback = unescaped === target
      ? []
      : findTrimmedOccurrences(text, unescaped).map((o) => ({ ...o, kind: "trimmed-unescaped" as const }));
    return { raw: [], fallback, trimmed };
  }
  const raw = findNeedleOccurrences(text, target);
  const unescaped = unescapeLiteralSequences(target);
  const fallback: Occurrence[] = unescaped === target ? [] : findNeedleOccurrences(text, unescaped).map((o) => ({ ...o, kind: "fallback" as const }));
  // Auto-cascade: only when neither the raw target nor its unescaped substring
  // form matches do we compute whole-line trim matches, so indentation or
  // trailing-whitespace drift still succeeds. Gating on the earlier tiers
  // missing keeps an exact match authoritative: it must not be diluted by a
  // trim occurrence elsewhere, which would turn a unique exact hit into an
  // ambiguous reject in the no-line/range path (allOccurrences). It mirrors
  // explicit trim mode exactly: trim of the target, plus trim-of-unescaped
  // when the target contains escape sequences, so auto-cascade stays
  // byte-identical to explicit matchMode:"trim" for escaped targets with
  // indentation drift.
  let trimmed: Occurrence[] = [];
  if (raw.length === 0 && fallback.length === 0) {
    trimmed = findTrimmedOccurrences(text, target);
    if (unescaped !== target) {
      fallback.push(...findTrimmedOccurrences(text, unescaped).map((o) => ({ ...o, kind: "trimmed-unescaped" as const })));
    }
  }
  return { raw, fallback, trimmed };
}

function overlaps(left: Occurrence, right: Occurrence): boolean {
  return left.start < right.end && right.start < left.end;
}

function allOccurrences(occurrences: TargetOccurrences): Occurrence[] {
  const exact = [...occurrences.raw, ...occurrences.fallback];
  // Only include trimmed occurrences that don't overlap with exact matches.
  const trimmed = occurrences.trimmed.filter((trim) => !exact.some((ex) => overlaps(ex, trim)));
  return [...exact, ...trimmed].sort((left, right) => left.start - right.start);
}

function selectOccurrences(
  occurrences: TargetOccurrences,
  selector: (occurrence: Occurrence) => boolean,
): Occurrence[] {
  const rawMatches = occurrences.raw.filter(selector);
  if (rawMatches.length > 0) return rawMatches;
  const fallbackMatches = occurrences.fallback.filter(selector);
  if (fallbackMatches.length > 0) return fallbackMatches;
  return occurrences.trimmed.filter(selector);
}

function matchTierNote(occurrences: Occurrence[]): string | undefined {
  if (occurrences.some((occurrence) => occurrence.kind === "trimmed-unescaped")) {
    return "matched via unescape+trim (escaped target and indentation/trailing whitespace normalized)";
  }
  if (occurrences.some((occurrence) => occurrence.kind === "trimmed")) {
    return "matched via trim (indentation or trailing whitespace differed)";
  }
  if (occurrences.some((occurrence) => occurrence.kind === "fallback")) {
    return "matched via unescape (escape sequences in target were normalized)";
  }
  return undefined;
}

function occurrenceCountNote(type: TargetEditOp["type"], count: number): string | undefined {
  if (count <= 1) return undefined;
  switch (type) {
    case "replace":
      return `replaced ${count} occurrences`;
    case "delete":
      return `deleted ${count} occurrences`;
    case "insert_before":
    case "insert_after":
      return `applied at ${count} occurrences`;
  }
}

function doubleIndentNote(
  op: TargetEditOp,
  occurrences: Occurrence[],
  text: string,
  offsets: number[],
): string | undefined {
  if (op.type !== "replace") return undefined;
  const occurrence = occurrences[0];
  if (!occurrence) return undefined;
  // Trim-shaped matches already strip replacement edge whitespace, so the
  // doubled-indent risk only applies to literal raw/unescape occurrences.
  if (occurrence.kind !== "raw" && occurrence.kind !== "fallback") return undefined;
  const lineStart = offsets[occurrence.startLine];
  if (lineStart === undefined) return undefined;
  const before = text.slice(lineStart, occurrence.start);
  if (!/^[\t ]+$/.test(before)) return undefined;
  const firstReplacementLine = op.replacement.split("\n")[0] ?? "";
  if (!/^[ \t]/.test(firstReplacementLine)) return undefined;
  return "replacement begins with whitespace that lands after the line's existing indentation - check for doubled indent";
}

function targetCandidates(lines: string[], needle: string): EditFailureCandidate[] {
  return closeLineMatches(lines, needle).map((match) => ({
    line: match.lineNumber,
    text: match.line.slice(0, 200),
    score: Number(match.score.toFixed(3)),
  }));
}

function throwTargetNotFound(index: number, target: string, lines: string[], text: string): never {
  const unescaped = unescapeLiteralSequences(target);
  const closeRaw = formatCloseLineMatches(lines, target, "close target matches");
  const closeUnescaped = unescaped !== target
    ? formatCloseLineMatches(lines, unescaped, "close target matches (after unescaping)")
    : "";
  const multiLineRaw = formatMultiLineTargetHints(lines, target);
  const multiLineUnescaped = unescaped !== target && unescaped.includes("\n")
    ? formatMultiLineTargetHints(lines, unescaped)
    : "";
  const escapeHint = unescaped !== target && text.includes(unescaped) && !text.includes(target)
    ? "hint: target uses escape sequences; the file matches the unescaped form — fix escapes or use literal newlines in target."
    : unescaped !== target && !text.includes(unescaped)
      ? "hint: check escape sequences in target (e.g. \\n, \\t)."
      : undefined;

  const candidates = targetCandidates(lines, target);
  const unescapedCandidates = unescaped !== target ? targetCandidates(lines, unescaped) : [];
  const uniqueCandidates = [...candidates];
  for (const candidate of unescapedCandidates) {
    if (!uniqueCandidates.some((existing) => existing.line === candidate.line && existing.text === candidate.text)) {
      uniqueCandidates.push(candidate);
    }
  }

  let suggested: Record<string, unknown> | undefined;
  if (unescaped !== target && text.includes(unescaped) && !text.includes(target)) {
    suggested = { target: unescaped };
  } else if (uniqueCandidates.length === 1) {
    suggested = { line: uniqueCandidates[0]!.line, target };
  }

  throwEditError(
    {
      error_code: "TARGET_NOT_FOUND",
      message: `op[${index}] target not found: ${JSON.stringify(target)}`,
      op_index: index,
      expected: target,
      ...(uniqueCandidates.length > 0 ? { candidates: uniqueCandidates } : {}),
      ...(suggested ? { suggested } : {}),
    },
    [closeRaw, closeUnescaped, multiLineRaw, multiLineUnescaped, escapeHint],
  );
}

function occurrenceCandidates(occurrences: Occurrence[], lines: string[]): EditFailureCandidate[] {
  return occurrences.slice(0, 10).map((occurrence) => ({
    line: occurrence.startLine + 1,
    text: (lines[occurrence.startLine] ?? "").slice(0, 200),
  }));
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
    throwEditError({
      error_code: "VALIDATION",
      message: `op[${index}] line must be a 1-indexed line number`,
      op_index: index,
    });
  }
  if (line > lineCount) {
    throwEditError({
      error_code: "RANGE_OUT_OF_BOUNDS",
      message: `op[${index}] line ${line} is out of bounds for file with ${lineCount} line(s)`,
      op_index: index,
      at_line: line,
      details: { line_count: lineCount },
    });
  }
  return line - 1;
}

function selectedOccurrences(op: TargetEditOp, text: string, lines: string[], offsets: number[], index: number): Occurrence[] {
  if (op.target.length === 0) {
    throwEditError({
      error_code: "VALIDATION",
      message: `op[${index}] target must not be empty`,
      op_index: index,
    });
  }
  if (op.target.includes("\r")) {
    throwEditError({
      error_code: "VALIDATION",
      message: `op[${index}] target must use \\n line endings, not \\r`,
      op_index: index,
    });
  }
  if (op.matchMode === "trim" && !hasMeaningfulTrimTarget(op.target)) {
    throwEditError({
      error_code: "VALIDATION",
      message: `op[${index}] target must contain non-whitespace content when matchMode is trim`,
      op_index: index,
    });
  }

  const occurrences = findTargetOccurrences(text, op.target, op.matchMode ?? "exact");
  if (occurrences.raw.length === 0 && occurrences.fallback.length === 0 && occurrences.trimmed.length === 0) {
    throwTargetNotFound(index, op.target, lines, text);
  }
  resolveOccurrenceLines(occurrences.raw, lines, offsets);
  resolveOccurrenceLines(occurrences.fallback, lines, offsets);
  resolveOccurrenceLines(occurrences.trimmed, lines, offsets);
  const all = allOccurrences(occurrences);

  if (op.type === "insert_before" || op.type === "insert_after") {
    const targetLine = validateLineSelector(op.line, lines.length, index);
    const matches = selectOccurrences(occurrences, (o) => o.startLine <= targetLine && o.endLine >= targetLine);
    if (matches.length === 0) {
      throwEditError(
        {
          error_code: "TARGET_NOT_FOUND",
          message: `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found 0`,
          op_index: index,
          at_line: op.line,
          expected: op.target,
          candidates: occurrenceCandidates(all, lines),
        },
        [formatOccurrenceLines(all, lines).replace(/^\n/, "")],
      );
    }
    if (matches.length > 1) {
      throwEditError(
        {
          error_code: "TARGET_AMBIGUOUS",
          message: `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found ${matches.length}`,
          op_index: index,
          at_line: op.line,
          expected: op.target,
          candidates: occurrenceCandidates(matches, lines),
          details: { found: matches.length },
        },
        [formatOccurrenceLines(matches, lines).replace(/^\n/, "")],
      );
    }
    return [matches[0]!];
  }

  const hasLine = op.line !== undefined;
  const hasRange = op.range !== undefined;

  // Helper to validate range bounds and return selected occurrences.
  function selectRange(range: { startLine: number; endLine: number }): Occurrence[] {
    if (!Number.isInteger(range.startLine) || range.startLine < 1) {
      throwEditError({
        error_code: "VALIDATION",
        message: `op[${index}] range.startLine must be a 1-indexed line number`,
        op_index: index,
      });
    }
    if (!Number.isInteger(range.endLine) || range.endLine < 1) {
      throwEditError({
        error_code: "VALIDATION",
        message: `op[${index}] range.endLine must be a 1-indexed line number`,
        op_index: index,
      });
    }
    if (range.endLine < range.startLine) {
      throwEditError({
        error_code: "INVALID_RANGE",
        message: `op[${index}] invalid range: lines ${range.startLine}-${range.endLine} (endLine < startLine)`,
        op_index: index,
        at_line: range.startLine,
        end_line: range.endLine,
      });
    }
    if (range.startLine > lines.length || range.endLine > lines.length) {
      throwEditError({
        error_code: "RANGE_OUT_OF_BOUNDS",
        message: `op[${index}] range ${range.startLine}-${range.endLine} is out of bounds for file with ${lines.length} line(s)`,
        op_index: index,
        at_line: range.startLine,
        end_line: range.endLine,
        details: { line_count: lines.length },
      });
    }
    const rangeStart = range.startLine - 1;
    const rangeEnd = range.endLine - 1;
    return selectOccurrences(occurrences, (o) => o.startLine >= rangeStart && o.endLine <= rangeEnd);
  }

  // line only: exactly one occurrence intersecting the line.
  if (hasLine && !hasRange) {
    const targetLine = validateLineSelector(op.line, lines.length, index);
    const matches = selectOccurrences(occurrences, (o) => o.startLine <= targetLine && o.endLine >= targetLine);
    if (matches.length === 0) {
      throwEditError(
        {
          error_code: "TARGET_NOT_FOUND",
          message: `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found 0`,
          op_index: index,
          ...(op.line !== undefined ? { at_line: op.line } : {}),
          expected: op.target,
          candidates: occurrenceCandidates(all, lines),
        },
        [formatOccurrenceLines(all, lines).replace(/^\n/, "")],
      );
    }
    if (matches.length > 1) {
      throwEditError(
        {
          error_code: "TARGET_AMBIGUOUS",
          message: `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found ${matches.length}`,
          op_index: index,
          ...(op.line !== undefined ? { at_line: op.line } : {}),
          expected: op.target,
          candidates: occurrenceCandidates(matches, lines),
          details: { found: matches.length },
        },
        [formatOccurrenceLines(matches, lines).replace(/^\n/, "")],
      );
    }
    return [matches[0]!];
  }

  // range only: every occurrence fully inside the inclusive range.
  if (!hasLine && hasRange) {
    const range = op.range!;
    const matches = selectRange(range);
    if (matches.length === 0) {
      throwEditError(
        {
          error_code: "TARGET_NOT_FOUND",
          message: `op[${index}] expected occurrences of ${JSON.stringify(op.target)} in lines ${range.startLine}-${range.endLine} but found 0`,
          op_index: index,
          at_line: range.startLine,
          end_line: range.endLine,
          expected: op.target,
          candidates: occurrenceCandidates(all, lines),
        },
        [formatOccurrenceLines(all, lines).replace(/^\n/, "")],
      );
    }
    return matches;
  }

  // both line and range: range selects all occurrences inside the range, then
  // verify at least one of them intersects the provided line (a validation hint).
  if (hasLine && hasRange) {
    const range = op.range!;
    const targetLine = validateLineSelector(op.line, lines.length, index);
    const rangeMatches = selectRange(range);
    if (rangeMatches.length === 0) {
      throwEditError(
        {
          error_code: "TARGET_NOT_FOUND",
          message: `op[${index}] expected occurrences of ${JSON.stringify(op.target)} in lines ${range.startLine}-${range.endLine} but found 0`,
          op_index: index,
          at_line: range.startLine,
          end_line: range.endLine,
          expected: op.target,
          candidates: occurrenceCandidates(all, lines),
        },
        [formatOccurrenceLines(all, lines).replace(/^\n/, "")],
      );
    }
    const intersecting = rangeMatches.filter((o) => o.startLine <= targetLine && o.endLine >= targetLine);
    if (intersecting.length === 0) {
      throwEditError(
        {
          error_code: "TARGET_AMBIGUOUS",
          message: `op[${index}] range ${range.startLine}-${range.endLine} selected ${rangeMatches.length} occurrence(s) of ${JSON.stringify(
            op.target,
          )} but none intersect line ${op.line}`,
          op_index: index,
          ...(op.line !== undefined ? { at_line: op.line } : {}),
          end_line: range.endLine,
          expected: op.target,
          candidates: occurrenceCandidates(rangeMatches, lines),
        },
        [formatOccurrenceLines(rangeMatches, lines).replace(/^\n/, "")],
      );
    }
    return rangeMatches;
  }

  // neither line nor range: target must be unique in the file.
  if (all.length === 0) {
    throwTargetNotFound(index, op.target, lines, text);
  }
  if (all.length > 1) {
    throwEditError(
      {
        error_code: "TARGET_AMBIGUOUS",
        message: `op[${index}] target ${JSON.stringify(op.target)} occurs ${all.length} times in the file; provide line or range to select one`,
        op_index: index,
        expected: op.target,
        candidates: occurrenceCandidates(all, lines),
        details: { found: all.length },
        suggested: { line: all[0]!.startLine + 1 },
      },
      [formatOccurrenceLines(all, lines).replace(/^\n/, "")],
    );
  }
  return [all[0]!];
}

function trimReplacementEdges(replacement: string): string {
  // Remove leading whitespace from the first line and trailing whitespace/empty
  // lines from the end while preserving internal newlines. This lets trim mode
  // tolerate copied indentation in the replacement without double-indenting or
  // consuming surrounding line endings.
  const lines = replacement.split("\n");
  if (lines.length === 0) return replacement;
  const firstLine = lines[0];
  if (firstLine !== undefined) lines[0] = firstLine.trimStart();
  // Drop trailing whitespace-only lines (from copied blank lines at the edge).
  while (lines.length > 1 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  const lastLine = lines[lines.length - 1];
  if (lastLine !== undefined) lines[lines.length - 1] = lastLine.trimEnd();
  return lines.join("\n");
}

function isTrimmedShape(occurrence: Occurrence): boolean {
  // Any occurrence whose bounds came from findTrimmedOccurrences is bounded to
  // the trimmed file content, so replace must trim replacement edges and delete
  // must expand to whole lines regardless of whether it also went through
  // unescaping. Labeling trim-of-unescaped as "fallback" would otherwise
  // double-indent on replace and orphan indentation-only lines on delete.
  return occurrence.kind === "trimmed" || occurrence.kind === "trimmed-unescaped";
}

function applyIndentAdjustment(trimmedReplacement: string, adjustment: IndentAdjustment): string | undefined {
  // Shift replacement lines 2..n to match the file's uniform indentation drift.
  // Line 1's indent is preserved by the file (it sits before occurrence.start),
  // so only subsequent lines are adjusted. Blank lines are left untouched. For
  // a "remove" shift, any line that lacks the prefix abandons the adjustment
  // (all-or-nothing) so no line is partially rewritten.
  if (adjustment.kind === "none") return trimmedReplacement;
  const lines = trimmedReplacement.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (adjustment.kind === "add") {
      lines[i] = adjustment.whitespace + line;
    } else if (line.startsWith(adjustment.whitespace)) {
      lines[i] = line.slice(adjustment.whitespace.length);
    } else {
      return undefined;
    }
  }
  return lines.join("\n");
}

function replaceRanges(text: string, occurrences: Occurrence[], replacement: string): string {
  // Gate the replacement semantics on the actual occurrence kind rather than
  // the op's matchMode. A trimmed occurrence (explicit matchMode:"trim", or
  // auto-cascade when raw/unescaped both miss) is bounded to the trimmed file
  // content, so the replacement must have its edges trimmed or the file's
  // original indentation would be doubled. Raw/fallback occurrences keep the
  // replacement literal. The trim tier detects a uniform indentation drift
  // between the caller's target and the file; each occurrence stores its own
  // delta and applies it to replacement lines 2..n so they land at the file's
  // indent instead of the caller's drifted indent.
  let updated = text;
  for (const occurrence of [...occurrences].reverse()) {
    let effectiveReplacement = isTrimmedShape(occurrence) ? trimReplacementEdges(replacement) : replacement;
    if (isTrimmedShape(occurrence) && occurrence.indent && occurrence.indent.kind !== "none") {
      const adjusted = applyIndentAdjustment(effectiveReplacement, occurrence.indent);
      if (adjusted !== undefined) effectiveReplacement = adjusted;
    }
    updated = `${updated.slice(0, occurrence.start)}${effectiveReplacement}${updated.slice(occurrence.end)}`;
  }
  return updated;
}

function deleteRanges(text: string, occurrences: Occurrence[]): string {
  // Delete and replace have different semantics for trimmed occurrences.
  // Replace keeps the file's indentation by staying bounded to the trimmed
  // content; delete removes a whole line, so leaving the trimmed content alone
  // would orphan an indentation-only line. A trimmed occurrence therefore
  // expands to the full line(s) and removes the line terminator. Raw/fallback
  // occurrences keep literal substring semantics.
  let updated = text;
  for (const occurrence of [...occurrences].reverse()) {
    let start = occurrence.start;
    let end = occurrence.end;
    if (isTrimmedShape(occurrence)) {
      start = text.lastIndexOf("\n", occurrence.start - 1) + 1;
      const terminatingNewline = text.indexOf("\n", occurrence.end);
      if (terminatingNewline !== -1) {
        // Line(s) terminated by a newline: remove the whole line including its
        // line ending and any trailing whitespace.
        end = terminatingNewline + 1;
      } else {
        // Last line has no trailing newline: remove it together with the
        // preceding line terminator so no dangling newline is left behind.
        if (start > 0 && text[start - 1] === "\n") start -= 1;
        end = text.length;
      }
    }
    updated = `${updated.slice(0, start)}${updated.slice(end)}`;
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

function unknownTypeError(op: TargetEditOp, index: number): never {
  throwEditError({
    error_code: "VALIDATION",
    message: `op[${index}] unknown type: ${JSON.stringify((op as { type?: unknown }).type)}`,
    op_index: index,
  });
}

function validatePayload(op: TargetEditOp, index: number): void {
  if (op.type !== "replace" && op.type !== "delete" && op.type !== "insert_before" && op.type !== "insert_after") {
    unknownTypeError(op, index);
  }
  if (op.type === "replace") {
    if (op.replacement.includes("\r")) {
      throwEditError({
        error_code: "VALIDATION",
        message: `op[${index}] replacement must use \\n line endings, not \\r`,
        op_index: index,
      });
    }
    if (op.replacement === op.target) {
      throwEditError({
        error_code: "VALIDATION",
        message: `op[${index}] replacement must differ from target`,
        op_index: index,
      });
    }
  }
  if (op.type === "insert_before" || op.type === "insert_after") {
    if (op.lines.length === 0) {
      throwEditError({
        error_code: "VALIDATION",
        message: `op[${index}] lines must contain at least one line`,
        op_index: index,
      });
    }
    for (const [lineIndex, line] of op.lines.entries()) {
      if (line.includes("\n") || line.includes("\r")) {
        throwEditError({
          error_code: "VALIDATION",
          message: `op[${index}] lines[${lineIndex}] must not contain line endings`,
          op_index: index,
        });
      }
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
  if (ops.length === 0) {
    throwEditError({ error_code: "EMPTY_BATCH", message: "ops must contain at least one target edit" });
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const source = splitBom(content);
  const lineEnding = detectLineEnding(source.text);
  const hasTrailingNewline = source.text.endsWith("\n");
  let state: LineState = { lines: splitLines(source.text), trailingNewline: hasTrailingNewline };
  const diffs: EditDiff[] = [];
  const notes: string[] = [];
  const multiOp = ops.length > 1;

  for (const [index, op] of ops.entries()) {
    validatePayload(op, index);
    const beforeLines = state.lines;
    const text = toNormalized(state);
    const offsets = lineStartOffsets(state.lines);
    const occurrences = selectedOccurrences(op, text, state.lines, offsets, index);
    const localNotes = [
      matchTierNote(occurrences),
      occurrenceCountNote(op.type, occurrences.length),
      doubleIndentNote(op, occurrences, text, offsets),
    ].filter(Boolean) as string[];
    if (localNotes.length > 0) {
      const combined = localNotes.join("; ");
      notes.push(multiOp ? `op[${index}] ${combined}` : combined);
    }

    switch (op.type) {
      case "insert_before":
      case "insert_after":
        state = applyInsert(state, occurrences, op);
        break;
      case "replace":
        state = fromNormalized(replaceRanges(text, occurrences, op.replacement));
        break;
      case "delete":
        state = fromNormalized(deleteRanges(text, occurrences));
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

  const byteNote = bytePropertiesNote(lineEnding, hasTrailingNewline);
  if (byteNote) notes.unshift(byteNote);

  await fs.writeFile(absolutePath, joinBom(toFileContent(state, lineEnding), source.bom), "utf8");

  const parts: string[] = [];
  if (notes.length > 0) parts.push(notes.join("\n"));
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
