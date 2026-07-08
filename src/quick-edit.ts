import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { throwEditError, type EditFailureCandidate } from "./edit-error.js";
import { closeLineMatches, formatCloseLineMatches } from "./fuzzy.js";
import {
  escapeMismatchHint,
  lineContentMatches,
  matchingLineNumbers,
  trimMismatchHint,
  type ExpectedStartLineMatch,
} from "./match-helpers.js";
import type { Edit } from "./schemas.js";
import { detectLineEnding, joinBom, splitBom, splitLines } from "./text.js";

type ResolvedEdit = {
  startLine: number;
  endLine: number;
  lines: string[];
  insert: boolean;
};

type GuardMode = ExpectedStartLineMatch;

type StartGuardFailure = {
  sections: string[];
  candidates?: EditFailureCandidate[];
  suggested?: Record<string, unknown>;
};

function validateLineRange(lineCount: number, edit: Edit, label: string, editIndex: number): ResolvedEdit {
  if (edit.start === "eof") {
    if (edit.end !== undefined) {
      throwEditError({
        error_code: "INVALID_RANGE",
        message: `${label} end must not be set when start is "eof"`,
        edit_index: editIndex,
      });
    }
    if (edit.lines.length === 0) {
      throwEditError({
        error_code: "VALIDATION",
        message: `${label} EOF insert must include at least one line`,
        edit_index: editIndex,
      });
    }
    if (edit.expectedEndLine !== undefined || edit.expectedLineCount !== undefined) {
      throwEditError({
        error_code: "VALIDATION",
        message: `${label} expectedEndLine/expectedLineCount are not valid for start="eof"`,
        edit_index: editIndex,
      });
    }
    return { startLine: lineCount + 1, endLine: lineCount + 1, lines: edit.lines, insert: true };
  }

  const startLine = edit.start;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throwEditError({
      error_code: "INVALID_RANGE",
      message: `${label} start must be a 1-indexed line number or "eof"`,
      edit_index: editIndex,
    });
  }

  if (edit.end === undefined && startLine === lineCount + 1) {
    if (edit.lines.length === 0) {
      throwEditError({
        error_code: "VALIDATION",
        message: `${label} EOF insert must include at least one line`,
        edit_index: editIndex,
      });
    }
    if (edit.expectedEndLine !== undefined || edit.expectedLineCount !== undefined) {
      throwEditError({
        error_code: "VALIDATION",
        message: `${label} expectedEndLine/expectedLineCount are not valid for EOF insert`,
        edit_index: editIndex,
      });
    }
    return { startLine, endLine: startLine, lines: edit.lines, insert: true };
  }

  const endLine = edit.end ?? startLine;
  if (!Number.isInteger(endLine) || endLine < 1) {
    throwEditError({
      error_code: "INVALID_RANGE",
      message: `${label} end must be a 1-indexed line number`,
      edit_index: editIndex,
      at_line: startLine,
    });
  }
  if (endLine < startLine) {
    throwEditError({
      error_code: "INVALID_RANGE",
      message: `${label} invalid range: lines ${startLine}-${endLine} (end < start)`,
      edit_index: editIndex,
      at_line: startLine,
      end_line: endLine,
    });
  }
  if (startLine > lineCount || endLine > lineCount) {
    throwEditError({
      error_code: "RANGE_OUT_OF_BOUNDS",
      message: `${label} range ${startLine}-${endLine} is out of bounds for file with ${lineCount} line(s)`,
      edit_index: editIndex,
      at_line: startLine,
      end_line: endLine,
      details: { line_count: lineCount },
    });
  }

  return { startLine, endLine, lines: edit.lines, insert: false };
}

function resolveMatchMode(edit: Edit, label: string, editIndex: number): GuardMode {
  if (edit.expectedStartLineMatch !== undefined) {
    if (edit.expectedStartLineMatch !== "exact" && edit.expectedStartLineMatch !== "trim") {
      throwEditError({
        error_code: "VALIDATION",
        message: `${label} expectedStartLineMatch must be "exact" or "trim"`,
        edit_index: editIndex,
      });
    }
    return edit.expectedStartLineMatch;
  }
  if (edit.whitespace === "indent_tolerant") return "trim";
  if (edit.whitespace !== undefined && edit.whitespace !== "strict") {
    throwEditError({
      error_code: "VALIDATION",
      message: `${label} whitespace must be "strict" or "indent_tolerant"`,
      edit_index: editIndex,
    });
  }
  return "exact";
}

function resolvePreserveIndent(edit: Edit): boolean {
  if (edit.preserveIndent !== undefined) return edit.preserveIndent;
  return edit.whitespace === "indent_tolerant";
}

function leadingIndent(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

function withPreservedIndent(lines: string[], indent: string): string[] {
  return lines.map((line) => line === "" ? line : `${indent}${line}`);
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

function candidateFromLines(lines: string[], lineNumbers: number[]): EditFailureCandidate[] {
  return lineNumbers.slice(0, 5).map((lineNumber) => ({
    line: lineNumber,
    text: (lines[lineNumber - 1] ?? "").slice(0, 200),
  }));
}

function analyzeStartGuardFailure(
  lines: string[],
  expectedStartLine: string,
  mode: GuardMode,
  startLine: number,
): StartGuardFailure {
  const actualAtStart = lines[startLine - 1] ?? "";
  const escapeHint = escapeMismatchHint(actualAtStart, expectedStartLine, mode);

  const matches = matchingLineNumbers(lines, expectedStartLine, mode);
  if (matches.length > 0) {
    const result: StartGuardFailure = {
      sections: [
        formatExpectedLineMatches(
          lines,
          matches,
          "Expected start line found at line(s)",
          escapeHint ?? trimMismatchHint(mode),
        ),
      ],
      candidates: candidateFromLines(lines, matches),
    };
    if (matches.length === 1) {
      result.suggested = { start: matches[0]!, expectedStartLine: lines[matches[0]! - 1] ?? "" };
    }
    return result;
  }

  if (mode === "exact") {
    const trimMatches = matchingLineNumbers(lines, expectedStartLine, "trim");
    if (trimMatches.length > 0) {
      const atStart = trimMatches.includes(startLine);
      const result: StartGuardFailure = {
        sections: [
          formatExpectedLineMatches(
            lines,
            trimMatches,
            "Expected start line matched by trim at line(s)",
            trimMismatchHint("exact"),
          ),
        ],
        candidates: candidateFromLines(lines, trimMatches),
        suggested: { whitespace: "indent_tolerant" },
      };
      if (!atStart && trimMatches.length === 1) {
        result.suggested = {
          start: trimMatches[0]!,
          expectedStartLine: (lines[trimMatches[0]! - 1] ?? "").trim(),
          whitespace: "indent_tolerant",
        };
      }
      return result;
    }
  }

  const close = closeLineMatches(lines, expectedStartLine);
  const closeMatches = formatCloseLineMatches(lines, expectedStartLine, "Close start-line matches");
  const trimTail = trimMismatchHint(mode);
  const sections = [closeMatches, escapeHint, trimTail].filter(Boolean) as string[];
  if (close.length === 0) sections.push("Read the file to see current content.");
  const result: StartGuardFailure = {
    sections: sections.length > 0 ? sections : ["Read the file to see current content."],
    candidates: close.map((match) => ({
      line: match.lineNumber,
      text: match.line.slice(0, 200),
      score: Number(match.score.toFixed(3)),
    })),
  };
  if (mode === "exact") result.suggested = { whitespace: "indent_tolerant" };
  return result;
}

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
  if (edits.length === 0) {
    throwEditError({ error_code: "EMPTY_BATCH", message: "edits must contain at least one replacement" });
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const source = splitBom(content);
  const lines = splitLines(source.text);
  const resolved = edits.map((edit, index) => validateLineRange(lines.length, edit, `edit[${index}]`, index));

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const resolvedEdit = resolved[index]!;
    const matchMode = resolveMatchMode(edit, `edit[${index}]`, index);
    const preserveIndent = resolvePreserveIndent(edit);

    if (resolvedEdit.insert) {
      // EOF / empty-file insert: no start-line content guard.
      continue;
    }

    if (edit.expectedStartLine === undefined) {
      throwEditError({
        error_code: "VALIDATION",
        message: `edit[${index}] expectedStartLine is required for line edits (omit only for start="eof")`,
        edit_index: index,
        at_line: resolvedEdit.startLine,
        suggested: { expectedStartLine: lines[resolvedEdit.startLine - 1] ?? "" },
      });
    }

    const expectedStartLine = edit.expectedStartLine;
    const actual = lines[resolvedEdit.startLine - 1] ?? "";
    if (!lineContentMatches(actual, expectedStartLine, matchMode)) {
      const analysis = analyzeStartGuardFailure(lines, expectedStartLine, matchMode, resolvedEdit.startLine);
      throwEditError(
        {
          error_code: "EXPECTED_START_LINE_MISMATCH",
          message: `edit[${index}] expectedStartLine mismatch at line ${resolvedEdit.startLine}; no edits were applied.`,
          edit_index: index,
          at_line: resolvedEdit.startLine,
          actual,
          expected: expectedStartLine,
          ...(analysis.candidates ? { candidates: analysis.candidates } : {}),
          ...(analysis.suggested ? { suggested: analysis.suggested } : {}),
        },
        analysis.sections,
      );
    }

    if (edit.expectedLineCount !== undefined) {
      if (!Number.isInteger(edit.expectedLineCount) || edit.expectedLineCount < 1) {
        throwEditError({
          error_code: "VALIDATION",
          message: `edit[${index}] expectedLineCount must be a positive integer`,
          edit_index: index,
        });
      }
      const actualCount = resolvedEdit.endLine - resolvedEdit.startLine + 1;
      if (actualCount !== edit.expectedLineCount) {
        throwEditError({
          error_code: "EXPECTED_LINE_COUNT_MISMATCH",
          message: `edit[${index}] expectedLineCount mismatch for range ${resolvedEdit.startLine}-${resolvedEdit.endLine}; no edits were applied.`,
          edit_index: index,
          at_line: resolvedEdit.startLine,
          end_line: resolvedEdit.endLine,
          details: { expected_line_count: edit.expectedLineCount, actual_line_count: actualCount },
          suggested: { expectedLineCount: actualCount },
        });
      }
    }

    if (edit.expectedEndLine !== undefined) {
      const actualEnd = lines[resolvedEdit.endLine - 1] ?? "";
      if (!lineContentMatches(actualEnd, edit.expectedEndLine, matchMode)) {
        const endMatches = matchingLineNumbers(lines, edit.expectedEndLine, matchMode);
        const sections: string[] = [];
        if (endMatches.length > 0) {
          sections.push(formatExpectedLineMatches(lines, endMatches, "Expected end line found at line(s)"));
        } else if (matchMode === "exact") {
          const trimEndMatches = matchingLineNumbers(lines, edit.expectedEndLine, "trim");
          if (trimEndMatches.length > 0) {
            sections.push(
              formatExpectedLineMatches(
                lines,
                trimEndMatches,
                "Expected end line matched by trim at line(s)",
                trimMismatchHint("exact"),
              ),
            );
          }
        }
        if (sections.length === 0) {
          const close = formatCloseLineMatches(lines, edit.expectedEndLine, "Close end-line matches");
          if (close) sections.push(close);
        }
        const endCandidates = endMatches.length > 0
          ? candidateFromLines(lines, endMatches)
          : closeLineMatches(lines, edit.expectedEndLine).map((match) => ({
            line: match.lineNumber,
            text: match.line.slice(0, 200),
            score: Number(match.score.toFixed(3)),
          }));
        let endSuggested: Record<string, unknown> | undefined;
        if (matchMode === "exact") {
          endSuggested = { whitespace: "indent_tolerant" };
        } else if (endMatches.length === 1) {
          endSuggested = { end: endMatches[0]!, expectedEndLine: lines[endMatches[0]! - 1] ?? "" };
        }
        throwEditError(
          {
            error_code: "EXPECTED_END_LINE_MISMATCH",
            message: `edit[${index}] expectedEndLine mismatch at line ${resolvedEdit.endLine}; no edits were applied.`,
            edit_index: index,
            at_line: resolvedEdit.startLine,
            end_line: resolvedEdit.endLine,
            actual: actualEnd,
            expected: edit.expectedEndLine,
            ...(endCandidates.length > 0 ? { candidates: endCandidates } : {}),
            ...(endSuggested ? { suggested: endSuggested } : {}),
          },
          sections.length > 0 ? sections : ["Read the file to see current content."],
        );
      }
    }

    if (preserveIndent) resolvedEdit.lines = withPreservedIndent(resolvedEdit.lines, leadingIndent(actual));
  }

  const ranges = resolved.map((edit) => [edit.startLine, edit.endLine] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const curr = ranges[i]!;
    if (prev[1] >= curr[0]) {
      throwEditError({
        error_code: "OVERLAPPING_RANGES",
        message: `overlapping edit ranges in batch: lines ${prev[0]}-${prev[1]} and ${curr[0]}-${curr[1]}`,
        details: {
          ranges: [
            { start: prev[0], end: prev[1] },
            { start: curr[0], end: curr[1] },
          ],
        },
      });
    }
  }

  const oldSnapshots = resolved.map((edit) => edit.insert ? [] : lines.slice(edit.startLine - 1, edit.endLine));
  const updated = [...lines];
  const indices = resolved.map((_, i) => i).sort((a, b) => resolved[b]!.startLine - resolved[a]!.startLine);

  for (const idx of indices) {
    const edit = resolved[idx]!;
    updated.splice(edit.startLine - 1, edit.insert ? 0 : edit.endLine - edit.startLine + 1, ...edit.lines);
  }

  const lineEnding = detectLineEnding(source.text);
  const hasTrailingNewline = source.text.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline && updated.length > 0) newContent += lineEnding;
  await fs.writeFile(absolutePath, joinBom(newContent, source.bom), "utf8");

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
