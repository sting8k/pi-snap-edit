import { Type } from "@sinclair/typebox";

export const QuickEditParams = Type.Object({
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

export const StructuredEditParams = Type.Object({
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

export type AnchorRangeInput = { start: string; end?: string };

export type StructuredEditOp =
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
