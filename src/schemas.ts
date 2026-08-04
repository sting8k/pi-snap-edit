import { Type } from "@sinclair/typebox";

export const FileStatParams = Type.Object({
  path: Type.String({ description: "Path to stat before line-based quick_edit." }),
});

const LineEditParams = Type.Object({
  start: Type.Integer({ minimum: 1, description: "1-indexed start line number. Use lineCount + 1 with no end to insert at EOF (legacy; prefer start=\"eof\")." }),
  end: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-indexed inclusive end line number." })),
  expectedStartLine: Type.Optional(Type.String({ description: "Guard for the current start line (required except for an empty-file insert). Exact by default; use whitespace=\"indent_tolerant\" or expectedStartLineMatch=trim for whitespace-tolerant guards. JSON-style escape sequences (e.g. \\n, \\t) are unescaped before comparing." })),
  expectedStartLineMatch: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("trim")], { description: "How to compare expectedStartLine/expectedEndLine. Defaults to exact unless whitespace is indent_tolerant (then trim). trim ignores leading/trailing whitespace." })),
  expectedEndLine: Type.Optional(Type.String({ description: "Optional guard for the current end line content. Uses the same match mode as expectedStartLine. Recommended for multi-line range edits." })),
  expectedLineCount: Type.Optional(Type.Integer({ minimum: 1, description: "Optional guard: expected number of lines in the start..end range (end-start+1). Rejects if the span size differs." })),
  whitespace: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("indent_tolerant")], {
    description: "Whitespace policy. strict (default): exact guards, no indent rewrite. indent_tolerant: trim guards + preserveIndent for replacement lines. Explicit expectedStartLineMatch/preserveIndent override the matching parts of this shortcut.",
  })),
  preserveIndent: Type.Optional(Type.Boolean({ description: "When true, prefixes the current start line indentation to each non-empty replacement line. Use unindented replacement lines. Defaults true when whitespace is indent_tolerant." })),
  lines: Type.Array(Type.String(), { description: "Replacement lines for the line/range. Empty array deletes it." }),
}, { description: "Replace, insert, or delete by line number or inclusive line range." });

const EofEditParams = Type.Object({
  start: Type.Literal("eof", { description: "Append at end of file." }),
  lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to append. Must contain at least one line." }),
}, { description: "Append-only EOF form. Send exactly start and lines; do not send end or guard fields." });

export const QuickEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  edits: Type.Array(
    Type.Union([EofEditParams, LineEditParams]),
    { minItems: 1, description: 'Line-number edits or EOF appends to apply atomically. For EOF, use exactly { start: "eof", lines: [...] }.' },
  ),
});

const TargetBase = {
  target: Type.String({ minLength: 1, description: "Exact literal target text to find. Use \\n for multi-line targets." }),
  matchMode: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("trim")], {
    default: "exact",
    description: "Match mode. exact (default) requires exact whitespace and matches substrings. trim compares whole lines after trimming leading/trailing whitespace; the occurrence is bounded to the trimmed content so original indentation is preserved, and replacement leading/trailing whitespace is stripped before writing.",
  })),
};

export const TargetEditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  ops: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("replace", { description: "Replace exact target text." }),
        ...TargetBase,
        line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line hint. When used alone, the target must appear exactly once on this line. When combined with range, at least one occurrence in the range must intersect this line. When omitted, the target must be unique in the file (unless range is provided)." })),
        range: Type.Optional(Type.Object({
          startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
          endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line." }),
        }, { description: "Inclusive line range; replaces every occurrence fully inside the range. May be combined with line as a validation hint." })),
        replacement: Type.String({ description: "Replacement text. Use \\n for multi-line replacements." }),
      }),
      Type.Object({
        type: Type.Literal("delete", { description: "Delete exact target text." }),
        ...TargetBase,
        line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line hint. When used alone, the target must appear exactly once on this line. When combined with range, at least one occurrence in the range must intersect this line. When omitted, the target must be unique in the file (unless range is provided)." })),
        range: Type.Optional(Type.Object({
          startLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive start line." }),
          endLine: Type.Integer({ minimum: 1, description: "1-indexed inclusive end line." }),
        }, { description: "Inclusive line range; deletes every occurrence fully inside the range. May be combined with line as a validation hint." })),
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

export type TargetReplaceOp = {
  type: "replace";
  target: string;
  line?: number;
  range?: { startLine: number; endLine: number };
  replacement: string;
  matchMode?: "exact" | "trim";
};

export type TargetDeleteOp = {
  type: "delete";
  target: string;
  line?: number;
  range?: { startLine: number; endLine: number };
  matchMode?: "exact" | "trim";
};

export type TargetInsertBeforeOp = {
  type: "insert_before";
  target: string;
  line: number;
  lines: string[];
  matchMode?: "exact" | "trim";
};

export type TargetInsertAfterOp = {
  type: "insert_after";
  target: string;
  line: number;
  lines: string[];
  matchMode?: "exact" | "trim";
};

export type TargetEditOp = TargetReplaceOp | TargetDeleteOp | TargetInsertBeforeOp | TargetInsertAfterOp;

export type Edit = {
  start: number | "eof";
  end?: number;
  expectedStartLine?: string;
  expectedStartLineMatch?: "exact" | "trim";
  expectedEndLine?: string;
  expectedLineCount?: number;
  whitespace?: "strict" | "indent_tolerant";
  preserveIndent?: boolean;
  lines: string[];
};
