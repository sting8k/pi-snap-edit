import { promises as fs } from "node:fs";
import { formatAmbiguousAnchorCandidates, formatHash, hashLines, lineHash, parseAnchor } from "./anchors.js";
import { CONTEXT_LINES, formatContexts, formatDiffs, type ContextRange, type EditDiff } from "./diff.js";
import type { Edit } from "./schemas.js";
import { detectLineEnding, splitLines } from "./text.js";

type ResolvedEdit = {
  startLine: number;
  startHash: string;
  endLine: number;
  endHash: string;
  lines: string[];
};

class AmbiguousAnchorError extends Error {
  constructor(
    public readonly hash: string,
    public readonly matches: number[],
    public readonly label: string,
    message: string,
  ) {
    super(message);
  }
}

function ambiguousAnchorMessage(lines: string[], label: string, hash: string, matches: number[]): string {
  const candidates = formatAmbiguousAnchorCandidates(lines, matches, hash);
  return (
    `${label}: ambiguous anchor ${formatHash(hash)} matched ${matches.length} current lines ` +
    `(${matches.slice(0, 8).join(", ")}${matches.length > 8 ? ", ..." : ""}); no edits were applied. ` +
    "Use a narrower range or read the target area again." +
    (candidates ? `\n\nCandidate contexts:\n${candidates}` : "")
  );
}

function resolveAnchorLine(lines: string[], anchorText: string, label: string): { line: number; hash: string; note?: string } {
  const anchor = parseAnchor(anchorText);
  if (!anchor) throw new Error(`${label}: invalid anchor '${anchorText}'. Expected '<hash>', e.g. 'ABCDE'.`);

  const total = lines.length;
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (lineHash(line) === anchor.hash) matches.push(index + 1);
  }

  if (matches.length === 1) {
    return { line: matches[0]!, hash: anchor.hash };
  }

  if (matches.length > 1) {
    throw new AmbiguousAnchorError(anchor.hash, matches, label, ambiguousAnchorMessage(lines, label, anchor.hash, matches));
  }

  throw new Error(`Stale anchor ${anchorText} at ${label}: no current line has matching hash; no edits were applied. Read the file again.`);
}

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
  if (edits.length === 0) throw new Error("edits must contain at least one replacement");

  const content = await fs.readFile(absolutePath, "utf8");
  const lines = splitLines(content);
  const mismatches: string[] = [];
  const ambiguous = new Map<string, { labels: string[]; matches: number[] }>();
  const resolved: ResolvedEdit[] = [];
  const resolveNotes: string[] = [];

  for (const [index, edit] of edits.entries()) {
    try {
      const start = resolveAnchorLine(lines, edit.start, `edit[${index}] start`);
      const end = edit.end === undefined ? start : resolveAnchorLine(lines, edit.end, `edit[${index}] end`);
      if (end.line < start.line) throw new Error(`Invalid range: ${start.line}-${end.line} (end < start)`);
      if (start.note) resolveNotes.push(start.note);
      if (end.note) resolveNotes.push(end.note);
      resolved.push({ startLine: start.line, startHash: start.hash, endLine: end.line, endHash: end.hash, lines: edit.lines });
    } catch (error) {
      if (error instanceof AmbiguousAnchorError) {
        const current = ambiguous.get(error.hash);
        if (current) {
          current.labels.push(error.label);
        } else {
          ambiguous.set(error.hash, { labels: [error.label], matches: error.matches });
        }
      } else {
        mismatches.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  for (const [hash, error] of ambiguous) {
    mismatches.push(ambiguousAnchorMessage(lines, error.labels.join(", "), hash, error.matches));
  }

  if (mismatches.length > 0) {
    throw new Error(`anchor resolution failed; no edits were applied.\n\n${mismatches.join("\n\n")}`);
  }

  const ranges = resolved.map((edit) => [edit.startLine, edit.endLine] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const curr = ranges[i]!;
    if (prev[1] >= curr[0]) {
      throw new Error(`overlapping edit ranges in batch: lines ${prev[0]}-${prev[1]} and ${curr[0]}-${curr[1]}`);
    }
  }

  const oldSnapshots = resolved.map((edit) => lines.slice(edit.startLine - 1, edit.endLine));
  const updated = [...lines];
  const indices = resolved.map((_, i) => i).sort((a, b) => resolved[b]!.startLine - resolved[a]!.startLine);

  for (const idx of indices) {
    const edit = resolved[idx]!;
    updated.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.lines);
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline) newContent += lineEnding;
  await fs.writeFile(absolutePath, newContent, "utf8");

  const ordered = resolved.map((_, i) => i).sort((a, b) => resolved[a]!.startLine - resolved[b]!.startLine);
  let offset = 0;
  const contextRanges: ContextRange[] = [];
  const diffs: EditDiff[] = [];

  for (const idx of ordered) {
    const edit = resolved[idx]!;
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
  if (resolveNotes.length > 0) parts.push(`── resolved anchors ──\n${resolveNotes.join("\n")}`);
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  const contexts = formatContexts(updated, contextRanges);
  if (contexts) parts.push(contexts);
  return parts.join("\n\n") || "Edits applied.";
}
