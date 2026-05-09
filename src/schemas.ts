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


export type Substitution = {
  old: string;
  new: string;
  count: number;
};

export type Edit = {
  start: number;
  end?: number;
  expectedStartLine: string;
  lines: string[];
};
