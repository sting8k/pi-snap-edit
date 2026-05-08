import { Type } from "@sinclair/typebox";

export const FileStatParams = Type.Object({
  path: Type.String({ description: "Path to stat before line-based quick_edit." }),
});

export const QuickEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  fileHash: Type.String({ description: "Required content file hash from read output. Prevents stale line-number edits." }),
  edits: Type.Array(
    Type.Object({
      start: Type.Integer({ minimum: 1, description: "1-indexed start line number. Use lineCount + 1 with no end to insert at EOF." }),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-indexed inclusive end line number." })),
      expectedStartLine: Type.Optional(Type.String({ description: "Optional exact guard for the current start line only. Does not check the full range." })),
      lines: Type.Array(Type.String(), { description: "Replacement lines for the line/range. Empty array deletes it." }),
    }),
    { minItems: 1, description: "Line-number edits to apply atomically. Use start=lineCount+1 with no end to insert at EOF. fileHash is required." },
  ),
});

export const SubstituteEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  fileHash: Type.String({ description: "Required content file hash from read output. Prevents stale line-number substitutions." }),
  start: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line. Required; substitute_edit never runs whole-file implicitly." }),
  end: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line. Must be within the current file." }),
  substitutions: Type.Array(
    Type.Object({
      old: Type.String({ description: "Exact literal substring to replace. Must be single-line and non-empty." }),
      new: Type.String({ description: "Literal replacement substring. Must be single-line." }),
      count: Type.Integer({ minimum: 1, description: "Required number of replacements for this substitution." }),
    }),
    { minItems: 1, description: "Ordered literal substitutions. Applied sequentially; count is checked before each substitution." },
  ),
});

export const StructuredEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  scope: Type.Optional(Type.Object({
    start: Type.String({ description: "Scope start anchor only, e.g. ABCDE. Exclude '|content'." }),
    end: Type.String({ description: "Scope end anchor only, e.g. VWXYZ. Exclude '|content'." }),
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
        start: Type.String({ description: "Start anchor only, e.g. ABCDE. Exclude '|content'." }),
        end: Type.Optional(Type.String({ description: "Optional end anchor only. Exclude '|content'." })),
        occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Select occurrence N when anchor is ambiguous (1-indexed)." })),
        lines: Type.Array(Type.String(), { description: "Replacement lines. Empty array deletes the range." }),
      }),
      Type.Object({
        type: Type.Literal("delete_lines"),
        start: Type.String({ description: "Start anchor only, e.g. ABCDE. Exclude '|content'." }),
        end: Type.Optional(Type.String({ description: "Optional end anchor only. Exclude '|content'." })),
        occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Select occurrence N when anchor is ambiguous (1-indexed)." })),
      }),
      Type.Object({
        type: Type.Literal("insert_before"),
        anchor: Type.String({ description: "Anchor only, e.g. ABCDE. Exclude '|content'." }),
        occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Select occurrence N when anchor is ambiguous (1-indexed)." })),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to insert before the anchor." }),
      }),
      Type.Object({
        type: Type.Literal("insert_after"),
        anchor: Type.String({ description: "Anchor only, e.g. ABCDE. Exclude '|content'." }),
        occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Select occurrence N when anchor is ambiguous (1-indexed)." })),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to insert after the anchor." }),
      }),
    ]),
    { minItems: 1, description: "Structured edit operations to apply atomically in order." },
  ),
});

export type AnchorRangeInput = { start: string; end?: string };

export type StructuredEditOp =
  | { type: "substitute"; old: string; new: string; count?: number }
  | { type: "replace_lines"; start: string; end?: string; occurrence?: number; lines: string[] }
  | { type: "delete_lines"; start: string; end?: string; occurrence?: number }
  | { type: "insert_before"; anchor: string; occurrence?: number; lines: string[] }
  | { type: "insert_after"; anchor: string; occurrence?: number; lines: string[] };

export type Substitution = {
  old: string;
  new: string;
  count: number;
};

export type Edit = {
  start: number;
  end?: number;
  expectedStartLine?: string;
  lines: string[];
};
