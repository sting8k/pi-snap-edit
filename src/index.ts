import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import path from "node:path";
import { preferQuickEditTools } from "./active-tools.js";
import { getFileStatSnapshot } from "./file-stat.js";
import { applyQuickEdits } from "./quick-edit.js";
import { color, renderQuickEditOutput, summarizeQuickEditOutput } from "./render.js";
import { QuickEditParams, SubstituteEditParams, TargetEditParams } from "./schemas.js";
import { applySubstituteEdits } from "./substitute-edit.js";
import { numberReadText } from "./read-hook.js";
import { applyTargetEdits } from "./target-edit.js";
export { formatHash, hashLines, lineHash } from "./anchors.js";
export { preferQuickEditTools } from "./active-tools.js";
export { getFileStatSnapshot } from "./file-stat.js";
export { applyQuickEdits } from "./quick-edit.js";
export type { Edit, Substitution, TargetEditOp, TargetEditScopeInput } from "./schemas.js";
export { summarizeQuickEditOutput } from "./render.js";
export { splitLines } from "./text.js";
export { applySubstituteEdits } from "./substitute-edit.js";
export { numberReadText } from "./read-hook.js";
export { applyTargetEdits } from "./target-edit.js";


function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function (pi: ExtensionAPI) {

  pi.registerTool({
    name: "quick_edit",
    label: "quick-edit",
    description:
      "Edit a file by 1-indexed line number or inclusive line range. Requires expectedStartLine for each edit to guard against stale line content. Atomic: any invalid edit rejects the whole batch.",
    promptSnippet: "Edit files by line number with expectedStartLine guard",
    promptGuidelines: [
      "Use start/end as 1-indexed line numbers from read, rg -n, grep -n, or srcwalk output.",
      "Always provide expectedStartLine with the exact current content of the start line to guard against stale edits.",
      `Omit end for a single-line replacement. Use lines: [] to delete a line or range. Use lines: [""] for one blank line.`,
      "Use start=lineCount+1 with no end to insert at EOF; for an empty file, start=1 inserts the first line.",
      "expectedStartLine only checks the start line; it does not verify the full range or detect line shifts from insertions/deletions above.",
      "Batch multiple independent ranges in one call; overlapping ranges are rejected atomically.",
    ],
    parameters: QuickEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () => applyQuickEdits(absolutePath, params.edits));
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
    name: "substitute_edit",
    label: "substitute-edit",
    description:
      "Apply ordered literal substitutions inside a required 1-indexed line range. Atomic: any count mismatch rejects the whole batch.",
    promptSnippet: "Substitute literal text inside a line range",
    promptGuidelines: [
      "Always provide a narrow start/end line range. substitute_edit never runs over the whole file implicitly.",
      "Use substitutions[] for ordered single-line literal replacements. No regex; use quick_edit for multi-line changes.",
      "Each substitution count is required and checked before that substitution is applied.",
      "Array order matters: later substitutions see earlier in-memory substitutions, but nothing is written unless all counts match.",
    ],
    parameters: SubstituteEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () =>
        applySubstituteEdits(absolutePath, params.start, params.end, params.substitutions),
      );
      return { content: [{ type: "text" as const, text }], details: undefined };
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(`${color(theme, "dim", "↳")} ${color(theme, "muted", "applying substitute-edit...")}`, 0, 0);

      const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      if ((result as any).isError) return new Text(color(theme, "error", text.trim() || "substitute-edit failed"), 0, 0);

      const summary = summarizeQuickEditOutput(text);
      const stats = summary.hasDiff
        ? ` ${color(theme, "success", `+${summary.additions}`)} ${color(theme, "error", `-${summary.removals}`)}`
        : "";
      const hint = !expanded && text ? ` ${color(theme, "muted", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
      const header = `${color(theme, "dim", "↳")} ${color(theme, "success", "substitute-edit applied")}${stats}${hint}`;

      if (!expanded || !text) return new Text(header, 0, 0);
      return new Text(`${header}\n${renderQuickEditOutput(theme, text)}`, 0, 0);
    },
  });


  pi.registerTool({
    name: "target_edit",
    label: "target-edit",
    description:
      "Edit by finding exact target text, then replace it, delete it, or insert full lines before/after the line(s) containing it. Atomic: any invalid operation rejects the whole batch.",
    promptSnippet: "Edit by exact target text with occurrence/count guards",
    promptGuidelines: [
      "Use target_edit when you know an exact marker/text but line numbers are inconvenient.",
      "Use exact literal target text only; no regex. Use \\n for multi-line targets and replacements.",
      "Every op must provide exactly one selector: occurrence for the Nth match, or count for exactly N matches.",
      "Use replace for inline or multi-line text replacement, delete for exact target removal, and insert for adding full lines before/after the line(s) containing target.",
      "Use optional scope.startLine/endLine to constrain matching when the file has repeated text.",
      "Batch operations are ordered in memory and written atomically only after all operations validate.",
    ],
    parameters: TargetEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () => applyTargetEdits(absolutePath, params.ops, params.scope));
      return { content: [{ type: "text" as const, text }], details: undefined };
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(`${color(theme, "dim", "↳")} ${color(theme, "muted", "applying target-edit...")}`, 0, 0);

      const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      if ((result as any).isError) return new Text(color(theme, "error", text.trim() || "target-edit failed"), 0, 0);

      const summary = summarizeQuickEditOutput(text);
      const stats = summary.hasDiff
        ? ` ${color(theme, "success", `+${summary.additions}`)} ${color(theme, "error", `-${summary.removals}`)}`
        : "";
      const hint = !expanded && text ? ` ${color(theme, "muted", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
      const header = `${color(theme, "dim", "↳")} ${color(theme, "success", "target-edit applied")}${stats}${hint}`;

      if (!expanded || !text) return new Text(header, 0, 0);
      return new Text(`${header}\n${renderQuickEditOutput(theme, text)}`, 0, 0);
    },
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;
    if (event.content.some((part) => part.type === "image")) return;
    if (!isRecord(event.input) || typeof event.input.path !== "string") return;

    const absolutePath = resolvePath(process.cwd(), event.input.path);
    const { lineCount } = await getFileStatSnapshot(absolutePath);
    const startLine = typeof event.input.offset === "number" && Number.isFinite(event.input.offset)
      ? Math.max(1, Math.floor(event.input.offset))
      : 1;
    return {
      content: event.content.map((part) =>
        part.type === "text" ? { ...part, text: numberReadText(part.text, { startLine, totalLineCount: lineCount }) } : part,
      ),
    };
  });

  pi.on("session_start", () => {
    const activeTools = pi.getActiveTools();
    const preferredTools = preferQuickEditTools(activeTools);
    if (preferredTools.join("\0") !== activeTools.join("\0")) {
      pi.setActiveTools(preferredTools);
    }
  });
}
