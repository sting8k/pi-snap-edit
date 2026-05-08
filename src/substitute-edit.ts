import { promises as fs } from "node:fs";
import { CONTEXT_LINES, type ContextRange, type EditDiff, formatContexts, formatDiffs } from "./diff.js";
import { getFileStatSnapshot, hashFileContent } from "./file-stat.js";
import type { Substitution } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

function countSubstring(text: string, needle: string): number {
  return needle.length === 0 ? 0 : text.split(needle).length - 1;
}

function validateLineRange(lineCount: number, start: number, end: number): void {
  if (!Number.isInteger(start) || start < 1) throw new Error("start must be a 1-indexed line number");
  if (!Number.isInteger(end) || end < 1) throw new Error("end must be a 1-indexed line number");
  if (end < start) throw new Error(`invalid range: lines ${start}-${end} (end < start)`);
  if (start > lineCount || end > lineCount) {
    throw new Error(`range ${start}-${end} is out of bounds for file with ${lineCount} line(s)`);
  }
}

function validateSubstitution(substitution: Substitution, index: number): void {
  if (substitution.old.length === 0) throw new Error(`substitution[${index}] old must not be empty`);
  if (substitution.old.includes("\n") || substitution.old.includes("\r") || substitution.new.includes("\n") || substitution.new.includes("\r")) {
    throw new Error(`substitution[${index}] old/new must be single-line; use quick_edit for multi-line changes`);
  }
  if (substitution.old === substitution.new) throw new Error(`substitution[${index}] old and new must differ`);
  if (!Number.isInteger(substitution.count) || substitution.count < 1) throw new Error(`substitution[${index}] count must be a positive integer`);
}

export async function applySubstituteEdits(
  absolutePath: string,
  fileHash: string,
  start: number,
  end: number,
  substitutions: Substitution[],
): Promise<string> {
  if (substitutions.length === 0) throw new Error("substitutions must contain at least one replacement");

  const snapshot = await getFileStatSnapshot(absolutePath);
  if (snapshot.fileHash !== fileHash) {
    throw new Error(
      [
        "stale fileHash; no edits were applied.",
        `expected: ${fileHash}`,
        "Read the file again to get the current fileHash before retrying.",
      ].join("\n"),
    );
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const lines = splitLines(content);
  validateLineRange(lines.length, start, end);

  const updated = [...lines];
  const diffs: EditDiff[] = [];
  const contextRanges: ContextRange[] = [];

  for (const [index, substitution] of substitutions.entries()) {
    validateSubstitution(substitution, index);

    let actualCount = 0;
    for (let i = start - 1; i < end; i++) {
      actualCount += countSubstring(updated[i]!, substitution.old);
    }

    if (actualCount !== substitution.count) {
      throw new Error(
        `substitution[${index}] expected ${substitution.count} occurrence(s) of ${JSON.stringify(substitution.old)} ` +
          `in lines ${start}-${end} but found ${actualCount}`,
      );
    }

    for (let i = start - 1; i < end; i++) {
      const before = updated[i]!;
      const after = before.split(substitution.old).join(substitution.new);
      if (after === before) continue;

      updated[i] = after;
      diffs.push({ oldStart: i + 1, newStart: i + 1, oldLines: [before], newLines: [after] });
      contextRanges.push({
        startIndex: Math.max(0, i - CONTEXT_LINES),
        endIndex: Math.min(updated.length, i + 1 + CONTEXT_LINES),
      });
    }
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline && updated.length > 0) newContent += lineEnding;
  await fs.writeFile(absolutePath, newContent, "utf8");

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  const contexts = formatContexts(updated, contextRanges);
  if (contexts) parts.push(contexts);
  parts.push(`fileHash: ${hashFileContent(newContent)}`);
  return parts.join("\n\n");
}
