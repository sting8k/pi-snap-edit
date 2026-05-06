import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const CONTEXT_LINES = 5;

const ReadParams = Type.Object({
  path: Type.String({ description: "Path to the text file to read." }),
  offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

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

type Edit = {
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

function lineHash(line: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(line, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xfff;
}

function formatHash(hash: number): string {
  return hash.toString(16).padStart(3, "0");
}

function hashLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}:${formatHash(lineHash(line))}|${line}`).join("\n");
}

function parseAnchor(anchor: string): { line: number; hash: number } | undefined {
  const [lineText, hashText, ...extra] = anchor.split(":");
  if (!lineText || !hashText || extra.length > 0) return undefined;
  const line = Number.parseInt(lineText.trim(), 10);
  const hash = Number.parseInt(hashText.trim(), 16);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(hash) || hash < 0) return undefined;
  return { line, hash };
}

function splitLines(content: string): string[] {
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
      const line = diff.oldLines[i];
      chunks.push(`- ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    for (let i = 0; i < diff.newLines.length; i++) {
      const lineNo = diff.newStart + i;
      const line = diff.newLines[i];
      chunks.push(`+ ${lineNo}:${formatHash(lineHash(line))}|${line}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}

async function readHashlinedFile(absolutePath: string, offset?: number, limit?: number): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  if (buffer.subarray(0, 8192).includes(0)) {
    return `# ${absolutePath}\n\n[Binary file omitted: quickedit read only hash-lines text files.]`;
  }

  const content = buffer.toString("utf8");
  const lines = splitLines(content);
  const startIndex = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  if (startIndex >= lines.length && lines.length > 0) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  }

  const requestedLimit = limit === undefined ? MAX_READ_LINES : Math.max(0, Math.floor(limit));
  let selected = lines.slice(startIndex, startIndex + requestedLimit);
  let output = hashLines(selected, startIndex + 1);

  while (Buffer.byteLength(output, "utf8") > MAX_READ_BYTES && selected.length > 1) {
    selected = selected.slice(0, Math.max(1, Math.floor(selected.length / 2)));
    output = hashLines(selected, startIndex + 1);
  }

  const endLine = startIndex + selected.length;
  if (endLine < lines.length) {
    output += `\n\n[Showing lines ${startIndex + 1}-${endLine} of ${lines.length}. Use offset=${endLine + 1} to continue.]`;
  }
  return output;
}

async function applyQuickEdits(absolutePath: string, edits: Edit[], showDiff: boolean): Promise<string> {
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
    const actualStartHash = lineHash(lines[startIndex]);
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
      const actualEndHash = lineHash(lines[endIndex]);
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
    const prev = ranges[i - 1];
    const curr = ranges[i];
    if (prev[1] >= curr[0]) {
      throw new Error(`overlapping edit ranges in batch: lines ${prev[0]}-${prev[1]} and ${curr[0]}-${curr[1]}`);
    }
  }

  const oldSnapshots = edits.map((edit) => lines.slice(edit.startLine - 1, edit.endLine));
  const updated = [...lines];
  const indices = edits.map((_, i) => i).sort((a, b) => edits[b].startLine - edits[a].startLine);

  for (const idx of indices) {
    const edit = edits[idx];
    const replacement = edit.content === "" ? [] : edit.content.split(/\r?\n/);
    updated.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement);
  }

  const lineEnding = detectLineEnding(content);
  const hasTrailingNewline = content.endsWith("\n");
  let newContent = updated.join(lineEnding);
  if (hasTrailingNewline) newContent += lineEnding;
  await fs.writeFile(absolutePath, newContent, "utf8");

  const ordered = edits.map((_, i) => i).sort((a, b) => edits[a].startLine - edits[b].startLine);
  let offset = 0;
  const contexts: string[] = [];
  const diffs: EditDiff[] = [];

  for (const idx of ordered) {
    const edit = edits[idx];
    const adjusted = Math.max(0, edit.startLine - 1 + offset);
    const oldCount = edit.endLine - edit.startLine + 1;
    const newLines = edit.content === "" ? [] : edit.content.split(/\r?\n/);
    const newStart = Math.max(1, adjusted + 1);

    diffs.push({ oldStart: edit.startLine, newStart, oldLines: oldSnapshots[idx], newLines });

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
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read a text file and return hash-anchored lines for safe quick_edit edits. Output format is <line>:<hash>|<content>. Use these anchors with quick_edit. For large files, use offset/limit to read the needed section.",
    promptSnippet: "Read file contents with hash anchors for quick_edit",
    promptGuidelines: [
      "Use read before quick_edit so you have current <line>:<hash> anchors.",
      "Do not invent quick_edit anchors; copy them from read output.",
    ],
    parameters: ReadParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await readHashlinedFile(absolutePath, params.offset, params.limit);
      return { content: [{ type: "text" as const, text }] };
    },
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
    renderShell: "self",

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
      return { content: [{ type: "text" as const, text }] };
    },

    renderCall(args, theme) {
      const count = Array.isArray(args?.edits) ? args.edits.length : 0;
      return new Text(`${theme.fg("toolTitle", theme.bold("quick-edit "))}${theme.fg("muted", `${args?.path ?? ""} (${count} edit${count === 1 ? "" : "s"})`)}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "⟳ Applying quick-edit..."), 0, 0);
      const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      if (!expanded) {
        const hint = keyHint("expandTools", "to expand");
        return new Text(theme.fg("success", "✓ quick-edit applied") + theme.fg("muted", ` (${hint})`), 0, 0);
      }
      return new Text(theme.fg("success", "✓ quick-edit applied") + (text ? `\n${theme.fg("toolOutput", text)}` : ""), 0, 0);
    },
  });
}
