import { Type } from "@sinclair/typebox";

export const FileStatParams = Type.Object({
  path: Type.String({ description: "Path to stat before line-based quick_edit." }),
});

export const QuickEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  edits: Type.Array(
    Type.Object({
      start: Type.Integer({ minimum: 1, description: "1-indexed start line number. Use lineCount + 1 with no end to insert at EOF." }),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-indexed inclusive end line number." })),
      expectedStartLine: Type.String({ description: "Guard for the current start line. Exact by default; set expectedStartLineMatch=trim to ignore leading/trailing whitespace." }),
      expectedStartLineMatch: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("trim")], { description: "How to compare expectedStartLine to the current start line. Defaults to exact; trim ignores leading/trailing whitespace." })),
      preserveIndent: Type.Optional(Type.Boolean({ description: "When true, prefixes the current start line indentation to each non-empty replacement line. Use unindented replacement lines." })),
      lines: Type.Array(Type.String(), { description: "Replacement lines for the line/range. Empty array deletes it." }),
    }),
    { minItems: 1, description: "Line-number edits to apply atomically. Use start=lineCount+1 with no end to insert at EOF." },
  ),
});

export const SubstituteEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  start: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
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

const LineRange = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
  endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line." }),
});

const TargetBase = {
  target: Type.String({ minLength: 1, description: "Exact literal target text to find. Use \\n for multi-line targets." }),
};

export const TargetEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  ops: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("replace", { description: "Replace exact target text." }),
        ...TargetBase,
        line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line where target must appear. Must find exactly 1 occurrence intersecting this line." })),
        range: Type.Optional(Type.Object({
          startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
          endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line." }),
        }, { description: "Inclusive line range; replaces every occurrence fully inside the range." })),
        replacement: Type.String({ description: "Replacement text. Use \\n for multi-line replacements." }),
      }),
      Type.Object({
        type: Type.Literal("delete", { description: "Delete exact target text." }),
        ...TargetBase,
        line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line where target must appear. Must find exactly 1 occurrence intersecting this line." })),
        range: Type.Optional(Type.Object({
          startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
          endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line." }),
        }, { description: "Inclusive line range; deletes every occurrence fully inside the range." })),
      }),
      Type.Object({
        type: Type.Literal("insert_before", { description: "Insert full lines before the target occurrence." }),
        ...TargetBase,
        line: Type.Integer({ minimum: 1, description: "1-indexed line where target must appear. Must find exactly 1 occurrence intersecting this line." }),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Full lines to insert before the first line containing target." }),
      }),
      Type.Object({
        type: Type.Literal("insert_after", { description: "Insert full lines after the target occurrence." }),
        ...TargetBase,
        line: Type.Integer({ minimum: 1, description: "1-indexed line where target must appear. Must find exactly 1 occurrence intersecting this line." }),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Full lines to insert after the last line containing target." }),
      }),
    ]),
    { minItems: 1, description: "Ordered exact-target operations. Atomic: any invalid operation rejects the whole batch." },
  ),
});

export type Substitution = {
  old: string;
  new: string;
  count: number;
};

export type TargetReplaceOp = {
  type: "replace";
  target: string;
  line?: number;
  range?: { startLine: number; endLine: number };
  replacement: string;
};

export type TargetDeleteOp = {
  type: "delete";
  target: string;
  line?: number;
  range?: { startLine: number; endLine: number };
};

export type TargetInsertBeforeOp = {
  type: "insert_before";
  target: string;
  line: number;
  lines: string[];
};

export type TargetInsertAfterOp = {
  type: "insert_after";
  target: string;
  line: number;
  lines: string[];
};

export type TargetEditOp = TargetReplaceOp | TargetDeleteOp | TargetInsertBeforeOp | TargetInsertAfterOp;

export type Edit = {
  start: number;
  end?: number;
  expectedStartLine: string;
  expectedStartLineMatch?: "exact" | "trim";
  preserveIndent?: boolean;
  lines: string[];
};
