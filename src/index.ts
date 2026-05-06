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
      content: Type.String({ description: "Replacement text for the anchored line/range. Empty string deletes it." }),
    }),
    { minItems: 1, description: "Hash-anchored edits to apply atomically." },
  ),
  diff: Type.Optional(Type.Boolean({ description: "Return a compact before/after diff." })),
});

export type Edit = {
  startLine: number;
  startHash: number;
  endLine: number;
  endHash: number;
  content: string;
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

export async function applyQuickEdits(absolutePath: string, edits: Edit[], showDiff: boolean): Promise<string> {
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
    const replacement = edit.content === "" ? [] : edit.content.split(/\r?\n/);
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
    const newLines = edit.content === "" ? [] : edit.content.split(/\r?\n/);
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
  if (showDiff) {
    const diff = formatDiffs(diffs);
    if (diff) parts.push(diff);
  }
  if (contexts.length > 0) parts.push(contexts.join("\n---\n"));
  return parts.join("\n\n") || "Edits applied.";
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
      "Edit a file using hash anchors from read output. Replaces the inclusive range from start to end. If end is omitted, replaces one line. Hash mismatch means the file changed; re-read and retry. This tool is atomic: any invalid edit rejects the whole batch.",
    promptSnippet: "Safely edit files using read's <line>:<hash> anchors",
    promptGuidelines: [
      "Prefer quick_edit after read when exact current anchors are available.",
      "Use start/end anchors copied from read output. Both line and hash are required.",
      "Set content to an empty string to delete a line or range.",
      "Use diff: true when you need a compact before/after diff.",
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
          content: edit.content,
        };
      });

      const text = await withFileMutationQueue(absolutePath, () => applyQuickEdits(absolutePath, edits, params.diff === true));
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
}
