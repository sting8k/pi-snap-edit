import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import path from "node:path";
import { parseAnchor } from "./anchors.js";
import { preferQuickEditTools } from "./active-tools.js";
import { applyQuickEdits } from "./quick-edit.js";
import { hashReadText } from "./read-hook.js";
import { color, renderQuickEditOutput, summarizeQuickEditOutput } from "./render.js";
import { QuickEditParams, StructuredEditParams } from "./schemas.js";
import { applyStructuredEdits } from "./structured-edit.js";

export { formatHash, hashLines, lineHash, parseAnchor } from "./anchors.js";
export { preferQuickEditTools } from "./active-tools.js";
export { applyQuickEdits } from "./quick-edit.js";
export { hashReadText } from "./read-hook.js";
export { summarizeQuickEditOutput } from "./render.js";
export type { Edit, StructuredEditOp } from "./schemas.js";
export { splitLines } from "./text.js";
export { applyStructuredEdits } from "./structured-edit.js";

function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
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
      "Use insert_after on the last anchored line to append content at EOF.",
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
