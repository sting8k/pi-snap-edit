import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import path from "node:path";
import { preferQuickEditTools } from "./active-tools.js";
import { getFileStatSnapshot, hashFileContent } from "./file-stat.js";
import { applyQuickEdits } from "./quick-edit.js";
import { hashReadText } from "./read-hook.js";
import { color, renderQuickEditOutput, summarizeQuickEditOutput } from "./render.js";
import { QuickEditParams, StructuredEditParams, SubstituteEditParams } from "./schemas.js";
import { applyStructuredEdits } from "./structured-edit.js";
import { applySubstituteEdits } from "./substitute-edit.js";
export { formatHash, hashLines, invalidAnchorMessage, lineHash, parseAnchor } from "./anchors.js";
export { preferQuickEditTools } from "./active-tools.js";
export { getFileStatSnapshot, hashFileContent } from "./file-stat.js";
export { applyQuickEdits } from "./quick-edit.js";
export { hashReadText } from "./read-hook.js";
export type { Edit, StructuredEditOp, Substitution } from "./schemas.js";
export { summarizeQuickEditOutput } from "./render.js";
export { splitLines } from "./text.js";
export { applyStructuredEdits } from "./structured-edit.js";
export { applySubstituteEdits } from "./substitute-edit.js";

const GUIDANCE_ERROR = "__piSnapEditGuidanceError";
const STRUCTURED_OP_TYPES = ["substitute", "replace_lines", "delete_lines", "insert_before", "insert_after"] as const;

const STRUCTURED_OP_EXAMPLES: Record<string, string> = {
  substitute: '{"type":"substitute","old":"...","new":"...","count":1}',
  replace_lines: '{"type":"replace_lines","start":"ABCDE","end":"VWXYZ","lines":["..."]}',
  delete_lines: '{"type":"delete_lines","start":"ABCDE","end":"VWXYZ"}',
  insert_before: '{"type":"insert_before","anchor":"ABCDE","lines":["..."]}',
  insert_after: '{"type":"insert_after","anchor":"ABCDE","lines":["..."]}',
};

const SCOPE_EXAMPLE = '"scope":{"start":"ABCDE","end":"VWXYZ"}';
const OPS_EXAMPLE = `"ops":[${STRUCTURED_OP_EXAMPLES.replace_lines}]`;

function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringField(value: Record<string, unknown>, field: string): boolean {
  return typeof value[field] === "string";
}

function hasStringArrayField(value: Record<string, unknown>, field: string, allowEmpty: boolean): boolean {
  const lines = value[field];
  return Array.isArray(lines) && (allowEmpty || lines.length > 0) && lines.every((line) => typeof line === "string");
}

function structuredGuidanceError(message: string): Record<string, unknown> {
  return {
    path: "__pi_snap_edit_invalid__",
    ops: [{ type: "substitute", old: "__pi_snap_edit_invalid__", new: "__pi_snap_edit_invalid__" }],
    [GUIDANCE_ERROR]: message,
  };
}

function validateStructuredOpShape(op: Record<string, unknown>, index: number): string | undefined {
  const type = op.type;
  if (typeof type !== "string" || !STRUCTURED_OP_TYPES.includes(type as any)) {
    return `Invalid structured_edit ops[${index}]. Allowed types: ${STRUCTURED_OP_TYPES.join(", ")}. For range replacement use: ${STRUCTURED_OP_EXAMPLES.replace_lines}`;
  }

  switch (type) {
    case "substitute":
      if (!hasStringField(op, "old") || !hasStringField(op, "new")) return `Invalid structured_edit ops[${index}] substitute. Correct syntax: ${STRUCTURED_OP_EXAMPLES.substitute}`;
      return undefined;
    case "replace_lines":
      if (!hasStringField(op, "start") || !hasStringArrayField(op, "lines", true)) return `Invalid structured_edit ops[${index}] replace_lines. Correct syntax: ${STRUCTURED_OP_EXAMPLES.replace_lines}`;
      return undefined;
    case "delete_lines":
      if (!hasStringField(op, "start")) return `Invalid structured_edit ops[${index}] delete_lines. Correct syntax: ${STRUCTURED_OP_EXAMPLES.delete_lines}`;
      return undefined;
    case "insert_before":
    case "insert_after":
      if (!hasStringField(op, "anchor") || !hasStringArrayField(op, "lines", false)) return `Invalid structured_edit ops[${index}] ${type}. Correct syntax: ${STRUCTURED_OP_EXAMPLES[type]}`;
      return undefined;
  }
}

function prepareStructuredEditArguments(input: unknown): any {
  if (!isRecord(input)) return input;

  if (input.scope !== undefined && !(isRecord(input.scope) && typeof input.scope.start === "string" && typeof input.scope.end === "string")) {
    return structuredGuidanceError(`Invalid structured_edit scope. Correct syntax: ${SCOPE_EXAMPLE}. Keep start/end inside scope.`);
  }

  if (!Array.isArray(input.ops)) {
    return structuredGuidanceError(`Invalid structured_edit arguments. Use ${OPS_EXAMPLE}.`);
  }
  if (input.ops.length === 0) {
    return structuredGuidanceError(`Invalid structured_edit ops. Must contain at least one operation. Example: ${OPS_EXAMPLE}`);
  }

  for (const [index, op] of input.ops.entries()) {
    if (!isRecord(op)) return structuredGuidanceError(`Invalid structured_edit ops[${index}]. Operation must be an object. Example: ${STRUCTURED_OP_EXAMPLES.replace_lines}`);
    const error = validateStructuredOpShape(op, index);
    if (error) return structuredGuidanceError(error);
  }

  return input;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;
    if (event.content.some((part) => part.type === "image")) return;
    if (!isRecord(event.input) || typeof event.input.path !== "string") return;

    const absolutePath = resolvePath(process.cwd(), event.input.path);
    const { fileHash } = await getFileStatSnapshot(absolutePath);
    return {
      content: event.content.map((part) =>
        part.type === "text" ? { ...part, text: hashReadText(part.text, fileHash) } : part,
      ),
    };
  });



  pi.registerTool({
    name: "quick_edit",
    label: "quick-edit",
    description:
      "Edit a file by 1-indexed line number or inclusive line range. Requires fileHash from the latest read output to prevent stale line-number edits. Atomic: any invalid edit rejects the whole batch.",
    promptSnippet: "Safely edit files by line number using read fileHash",
    promptGuidelines: [
      "Use fileHash from the latest read output for this file; do not guess line numbers from memory.",
      "Use start/end as 1-indexed line numbers from read, rg -n, grep -n, or srcwalk output, but keep fileHash from read.",
      `Omit end for a single-line replacement. Use lines: [] to delete a line or range. Use lines: [""] for one blank line.`,
      "Use start=lineCount+1 with no end to insert at EOF; for an empty file, start=1 inserts the first line.",
      "Use expectedStartLine when you want an exact guard for the current start line only; it does not check the full range.",
      "Batch multiple independent ranges in one call; overlapping ranges are rejected atomically.",
      "If quick_edit reports a stale fileHash, read the current file/range again before retrying.",
    ],
    parameters: QuickEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () => applyQuickEdits(absolutePath, params.fileHash, params.edits));
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
      "Apply ordered literal substitutions inside a required 1-indexed line range. Requires fileHash from the latest read output. Atomic: any count mismatch rejects the whole batch.",
    promptSnippet: "Safely substitute literal text inside a line range using read fileHash",
    promptGuidelines: [
      "Use fileHash from the latest read output for this file; stale fileHash rejects the edit.",
      "Always provide a narrow start/end line range. substitute_edit never runs over the whole file implicitly.",
      "Use substitutions[] for ordered single-line literal replacements. No regex; use quick_edit for multi-line changes.",
      "Each substitution count is required and checked before that substitution is applied.",
      "Array order matters: later substitutions see earlier in-memory substitutions, but nothing is written unless all counts match.",
    ],
    parameters: SubstituteEditParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const text = await withFileMutationQueue(absolutePath, () =>
        applySubstituteEdits(absolutePath, params.fileHash, params.start, params.end, params.substitutions),
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
    name: "structured_edit",
    label: "structured-edit",
    description:
      "Edit a file with structured operations. Anchor fields must be only the <hash> prefix before '|'; never include '|content'. Uses counted substitutions and anchored line operations atomically.",
    promptSnippet: "Apply substitutions and line ops using only <hash> anchors",
    promptGuidelines: [
      "Use structured_edit for several edits in one file from the same latest read snapshot.",
      "For every scope/start/end/anchor field, copy only the <hash> prefix before '|', e.g. 'ABCDE'.",
      "Correct shape example: {\"path\":\"file\",\"scope\":{\"start\":\"ABCDE\",\"end\":\"VWXYZ\"},\"ops\":[{\"type\":\"replace_lines\",\"start\":\"ABCDE\",\"end\":\"VWXYZ\",\"lines\":[\"...\"]}]}",
      "Use replace_lines for anchored range replacement; use substitute only for single-line old/new strings.",
      "Use insert_after on the last anchored line to append content at EOF.",
      "Do not make multiple quick_edit calls in the same file when one structured_edit call can express the changes.",
    ],
    parameters: StructuredEditParams,
    prepareArguments: prepareStructuredEditArguments,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const guidanceError = (params as any)[GUIDANCE_ERROR];
      if (typeof guidanceError === "string") throw new Error(guidanceError);
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
