import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import path from "node:path";

const CONTEXT_LINES = 5;

const QuickEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  edits: Type.Array(
    Type.Object({
      start: Type.String({ description: "Start anchor from read output, formatted as <line>:<hash>." }),
      end: Type.Optional(Type.String({ description: "Optional inclusive end anchor, formatted as <line>:<hash>." })),
      lines: Type.Array(Type.String(), { description: "Replacement lines for the anchored line/range. Empty array deletes it." }),
    }),
    { minItems: 1, description: "Hash-anchored edits to apply atomically." },
  ),
});

const StructuredEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  scope: Type.Optional(Type.Object({
    start: Type.String({ description: "Start anchor limiting substitute operations." }),
    end: Type.String({ description: "Inclusive end anchor limiting substitute operations." }),
  })),
  ops: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("substitute"),
        old: Type.String({ description: "Exact substring to replace. Newlines are not allowed; use line ops for multi-line changes." }),
        new: Type.String({ description: "Replacement substring. Newlines are not allowed; use line ops for multi-line changes." }),
        count: Type.Optional(Type.Integer({ minimum: 1, description: "Required number of replacements. Defaults to 1." })),
      }),
      Type.Object({
        type: Type.Literal("replace_lines"),
        start: Type.String({ description: "Start anchor from read output." }),
        end: Type.Optional(Type.String({ description: "Optional inclusive end anchor from read output." })),
        lines: Type.Array(Type.String(), { description: "Replacement lines. Empty array deletes the range." }),
      }),
      Type.Object({
        type: Type.Literal("delete_lines"),
        start: Type.String({ description: "Start anchor from read output." }),
        end: Type.Optional(Type.String({ description: "Optional inclusive end anchor from read output." })),
      }),
      Type.Object({
        type: Type.Literal("insert_before"),
        anchor: Type.String({ description: "Anchor line to insert before." }),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to insert before the anchor." }),
      }),
      Type.Object({
        type: Type.Literal("insert_after"),
        anchor: Type.String({ description: "Anchor line to insert after." }),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to insert after the anchor." }),
      }),
    ]),
    { minItems: 1, description: "Structured edit operations to apply atomically in order." },
  ),
});

type AnchorRangeInput = { start: string; end?: string };

type StructuredEditOp =
  | { type: "substitute"; old: string; new: string; count?: number }
  | { type: "replace_lines"; start: string; end?: string; lines: string[] }
  | { type: "delete_lines"; start: string; end?: string }
  | { type: "insert_before"; anchor: string; lines: string[] }
  | { type: "insert_after"; anchor: string; lines: string[] };
export type Edit = {
  startLine: number;
  startHash: number;
  endLine: number;
  endHash: number;
  lines: string[];
};

type EditDiff = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

export function lineHash(line: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(line, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xfff;
}

export function formatHash(hash: number): string {
  return hash.toString(16).padStart(3, "0");
}

export function hashLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}:${formatHash(lineHash(line))}|${line}`).join("\n");
}

export function parseAnchor(anchor: string): { line: number; hash: number } | undefined {
  const [lineText, hashText, ...extra] = anchor.split(":");
  if (!lineText || !hashText || extra.length > 0) return undefined;
  const line = Number.parseInt(lineText.trim(), 10);
  const hash = Number.parseInt(hashText.trim(), 16);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(hash) || hash < 0) return undefined;
  return { line, hash };
}

export function splitLines(content: string): string[] {
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
  if (withoutTrailingNewline.length === 0) return [];
  return withoutTrailingNewline.split(/\r?\n/);
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function formatDiffs(diffs: EditDiff[]): string {
  if (diffs.length === 0) return "";
  const chunks: string[] = ["── diff ──"];

  for (const diff of diffs) {
    const oldEnd = diff.oldStart + Math.max(0, diff.oldLines.length - 1);
    if (diff.oldLines.length <= 1 && diff.newLines.length <= 1) {
      chunks.push(`:${diff.oldStart}`);
    } else {
      const newEnd = diff.newStart + Math.max(0, diff.newLines.length - 1);
      chunks.push(`:${diff.oldStart}-${Math.max(oldEnd, newEnd)}`);
    }

    for (let i = 0; i < diff.oldLines.length; i++) {
      const lineNo = diff.oldStart + i;
      const line = diff.oldLines[i]!;
      chunks.push(`- ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    for (let i = 0; i < diff.newLines.length; i++) {
      const lineNo = diff.newStart + i;
      const line = diff.newLines[i]!;
      chunks.push(`+ ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}

export type QuickEditRenderSummary = {
  additions: number;
  removals: number;
  hasDiff: boolean;
};

export function summarizeQuickEditOutput(text: string): QuickEditRenderSummary {
  let inDiff = false;
  let additions = 0;
  let removals = 0;

  for (const line of text.split("\n")) {
    if (line === "── diff ──") {
      inDiff = true;
      continue;
    }
    if (inDiff && line === "") continue;
    if (inDiff && line === "---") break;
    if (!inDiff) continue;

    if (line.startsWith("+ ")) additions++;
    else if (line.startsWith("- ")) removals++;
  }

  return { additions, removals, hasDiff: additions > 0 || removals > 0 };
}

export function preferQuickEditTools(activeTools: string[]): string[] {
  const withoutEdit = activeTools.filter((toolName) => toolName !== "edit");
  return ["quick_edit", "structured_edit"].reduce(
    (tools, toolName) => (tools.includes(toolName) ? tools : [...tools, toolName]),
    withoutEdit,
  );
}

type QuickEditTheme = {
  fg?: (role: any, text: string) => string;
  bold?: (text: string) => string;
};

function color(theme: QuickEditTheme, role: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(role, text) : text;
}

function renderAnchoredLine(theme: QuickEditTheme, marker: string, line: string, role: string): string | undefined {
  const match = line.match(/^(\d+):([0-9a-f]{3})\|(.*)$/);
  if (!match) return undefined;
  const [, lineNo, hash, content] = match;
  const gutter = `${marker} ${lineNo}:${hash} │ `;
  return `${color(theme, "muted", gutter)}${color(theme, role, content ?? "")}`;
}

function renderQuickEditLine(theme: QuickEditTheme, line: string): string {
  if (line === "── diff ──") return color(theme, "muted", "diff");
  if (line === "---") return color(theme, "muted", "---");
  if (/^:\d+(?:-\d+)?$/.test(line)) return color(theme, "muted", line);

  if (line.startsWith("+ ")) {
    return renderAnchoredLine(theme, "+", line.slice(2), "success") ?? color(theme, "success", line);
  }
  if (line.startsWith("- ")) {
    return renderAnchoredLine(theme, "-", line.slice(2), "error") ?? color(theme, "error", line);
  }

  return renderAnchoredLine(theme, " ", line, "toolOutput") ?? color(theme, "toolOutput", line);
}

function renderQuickEditOutput(theme: QuickEditTheme, text: string): string {
  return text.split("\n").map((line) => renderQuickEditLine(theme, line)).join("\n");
}

export function hashReadText(text: string, offsetInput: unknown): string {
  if (text.startsWith("Read image file ") || text.startsWith("[Line ")) return text;

  const noticeMatch = text.match(/\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\])$/);
  const body = noticeMatch ? text.slice(0, noticeMatch.index) : text;
  const notice = noticeMatch ? `\n\n${noticeMatch[1]}` : "";
  const startLine = typeof offsetInput === "number" && Number.isFinite(offsetInput) ? Math.max(1, Math.floor(offsetInput)) : 1;
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));

  return hashLines(lines, startLine) + notice;
}

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
  const contexts: string[] = [];
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
    if (contextStart < contextEnd) {
      contexts.push(hashLines(updated.slice(contextStart, contextEnd), contextStart + 1));
    }

    offset += newLines.length - oldCount;
  }

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  if (contexts.length > 0) parts.push(contexts.join("\n---\n"));
  return parts.join("\n\n") || "Edits applied.";
}

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
    const oldLine = currentLines[currentLine - 1]!;
    const newLines = after ? [oldLine, ...insertedLines] : [...insertedLines, oldLine];
    applyLineReplacement({ start: anchor }, newLines, label);
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

  for (const op of ops) {
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
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = currentLines.join(lineEnding);
  if (hasTrailingNewline) newContent += lineEnding;
  if (newContent === content) throw new Error("structured_edit made no changes");

  await fs.writeFile(absolutePath, newContent, "utf8");

  const contexts: string[] = [];
  for (const diff of diffs) {
    const startIndex = Math.max(0, diff.newStart - 1 - CONTEXT_LINES);
    const newLineCount = Math.max(1, diff.newLines.length);
    const endIndex = Math.min(currentLines.length, diff.newStart - 1 + newLineCount + CONTEXT_LINES);
    if (startIndex < endIndex) {
      contexts.push(hashLines(currentLines.slice(startIndex, endIndex), startIndex + 1));
    }
  }

  const parts: string[] = [];
  const diff = formatDiffs(diffs);
  if (diff) parts.push(diff);
  if (contexts.length > 0) parts.push(contexts.join("\n---\n"));
  return parts.join("\n\n") || "Structured edit applied.";
}
export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || event.isError) return;
    if (event.content.some((part) => part.type === "image")) return;

    return {
      content: event.content.map((part) =>
        part.type === "text" ? { ...part, text: hashReadText(part.text, event.input.offset) } : part,
      ),
    };
  });

  pi.registerTool({
    name: "quick_edit",
    label: "quick-edit",
    description:
      "Edit a file using hash anchors from read output. Replaces the inclusive range from start to end with lines[]. If end is omitted, replaces one line. Hash mismatch means the file changed; re-read and retry. This tool is atomic: any invalid edit rejects the whole batch.",
    promptSnippet: "Safely edit files using read's <line>:<hash> anchors",
    promptGuidelines: [
      "Prefer quick_edit after read when exact current anchors are available.",
      "Use start/end anchors copied from read output. Both line and hash are required.",
      "Use lines for replacement text. Each array entry is one output line; use lines: [] to delete a line or range.",
    ],
    parameters: QuickEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const edits = params.edits.map((edit, i) => {
        const start = parseAnchor(edit.start);
        if (!start) throw new Error(`edit[${i}]: invalid start anchor '${edit.start}'`);
        const end = edit.end === undefined ? start : parseAnchor(edit.end);
        if (!end) throw new Error(`edit[${i}]: invalid end anchor '${edit.end}'`);
        return {
          startLine: start.line,
          startHash: start.hash,
          endLine: end.line,
          endHash: end.hash,
          lines: edit.lines,
        };
      });

      const text = await withFileMutationQueue(absolutePath, () => applyQuickEdits(absolutePath, edits));
      return { content: [{ type: "text" as const, text }], details: undefined };
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(`${color(theme, "dim", "↳")} ${color(theme, "muted", "applying quick-edit...")}`, 0, 0);

      const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      if ((result as any).isError) return new Text(color(theme, "error", text.trim() || "quick-edit failed"), 0, 0);

      const summary = summarizeQuickEditOutput(text);
      const stats = summary.hasDiff
        ? ` ${color(theme, "success", `+${summary.additions}`)} ${color(theme, "error", `-${summary.removals}`)}`
        : "";
      const hint = !expanded && text ? ` ${color(theme, "muted", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
      const header = `${color(theme, "dim", "↳")} ${color(theme, "success", "quick-edit applied")}${stats}${hint}`;

      if (!expanded || !text) return new Text(header, 0, 0);
      return new Text(`${header}\n${renderQuickEditOutput(theme, text)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "structured_edit",
    label: "structured-edit",
    description:
      "Edit a file with structured operations. Use substitute for counted single-line substring replacements inside an optional anchored scope, and use anchored line operations for insert/delete/replace. This tool is atomic: any invalid anchor, count mismatch, or stale hash rejects the whole batch.",
    promptSnippet: "Apply scoped counted substitutions and anchored line operations atomically",
    promptGuidelines: [
      "Use structured_edit for complex edits inside a long block when several small substitutions/inserts/deletes avoid rewriting the whole block.",
      "Use scope with start/end anchors to limit substitute operations to one block from read output.",
      "Use substitute for single-line substring replacements with count as an assertion. Use line operations for multi-line changes.",
      "Use quick_edit instead when you only need one simple anchored range replacement.",
    ],
    parameters: StructuredEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () => applyStructuredEdits(absolutePath, params.ops, params.scope));
      return { content: [{ type: "text" as const, text }], details: undefined };
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(`${color(theme, "dim", "↳")} ${color(theme, "muted", "applying structured-edit...")}`, 0, 0);

      const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      if ((result as any).isError) return new Text(color(theme, "error", text.trim() || "structured-edit failed"), 0, 0);

      const summary = summarizeQuickEditOutput(text);
      const stats = summary.hasDiff
        ? ` ${color(theme, "success", `+${summary.additions}`)} ${color(theme, "error", `-${summary.removals}`)}`
        : "";
      const hint = !expanded && text ? ` ${color(theme, "muted", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
      const header = `${color(theme, "dim", "↳")} ${color(theme, "success", "structured-edit applied")}${stats}${hint}`;

      if (!expanded || !text) return new Text(header, 0, 0);
      return new Text(`${header}\n${renderQuickEditOutput(theme, text)}`, 0, 0);
    },
  });
  pi.on("session_start", () => {
    const activeTools = pi.getActiveTools();
    const preferredTools = preferQuickEditTools(activeTools);
    if (preferredTools.join("\0") !== activeTools.join("\0")) {
      pi.setActiveTools(preferredTools);
    }
  });
}
