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
      expectedStartLine: Type.String({ description: "Required exact guard for the current start line. Does not check the full range." }),
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

export const TargetEditScope = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive scope start line." }),
  endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive scope end line." }),
});

const TargetSelectorFields = {
  target: Type.String({ minLength: 1, description: "Exact literal target text to find. Use \\n for multi-line targets." }),
  occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Apply to the Nth occurrence of target." })),
  count: Type.Optional(Type.Integer({ minimum: 1, description: "Apply to exactly this many occurrences of target." })),
};

export const TargetEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  scope: Type.Optional(TargetEditScope),
  ops: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("replace"),
        ...TargetSelectorFields,
        replacement: Type.String({ description: "Replacement text. Use \\n for multi-line replacements." }),
      }),
      Type.Object({
        type: Type.Literal("insert"),
        ...TargetSelectorFields,
        position: Type.Union([Type.Literal("before"), Type.Literal("after")], { description: "Insert lines before or after the line(s) containing target." }),
        lines: Type.Array(Type.String(), { minItems: 1, description: "Full lines to insert." }),
      }),
      Type.Object({
        type: Type.Literal("delete"),
        ...TargetSelectorFields,
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

export type TargetSelector = {
  target: string;
  occurrence?: number;
  count?: number;
};

export type TargetReplaceOp = TargetSelector & {
  type: "replace";
  replacement: string;
};

export type TargetInsertOp = TargetSelector & {
  type: "insert";
  position: "before" | "after";
  lines: string[];
};

export type TargetDeleteOp = TargetSelector & {
  type: "delete";
};

export type TargetEditOp = TargetReplaceOp | TargetInsertOp | TargetDeleteOp;

export type TargetEditScopeInput = {
  startLine: number;
  endLine: number;
};

export type Edit = {
  start: number;
  end?: number;
  expectedStartLine: string;
  lines: string[];
};
