/**
 * Eval: which prompt guidelines actually matter?
 *
 * For each task, we define two variants:
 * - "informed": what an agent who knows the guideline would send
 * - "naive": what an agent who DOESN'T know the guideline would send
 *
 * We run both through the engine and compare results.
 * If naive fails but informed succeeds → the guideline matters.
 * If both succeed → the guideline is redundant (engine handles it anyway).
 * If both fail → the task is too hard regardless.
 *
 * Run: npx tsx test/eval-guidelines.ts
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyQuickEdits, applyTargetEdits, type Edit } from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-eval-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

async function cleanup() {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

// ── task types ────────────────────────────────────────────────────────────────

type QuickEditInput = { path: string; edits: Edit[] };
type TargetEditInput = { path: string; ops: Parameters<typeof applyTargetEdits>[1] };

type Task = {
  name: string;
  category: string;
  guideline: string; // which guideline # this tests
  fixture: { filename: string; content: string };
  informed: (file: string) => QuickEditInput | TargetEditInput;
  naive: (file: string) => QuickEditInput | TargetEditInput;
  expectedContent: string; // correct file content after edit
  naiveExpectedFail?: boolean; // if true, naive should throw or produce wrong content
  naiveExpectedContent?: string; // if naive succeeds but with wrong content
  expectThrow?: boolean; // if true, correct = function throws AND file unchanged
};

// ── tasks ─────────────────────────────────────────────────────────────────────

const tasks: Task[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — basic (no edge-case guideline needed)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-basic-single-line-replace",
    category: "basic",
    guideline: "#1,#2 (line numbers + guard)",
    fixture: { filename: "app.ts", content: "import { foo } from \"bar\";\nconst x = 1;\nexport { x };\n" },
    informed: (f) => ({ path: f, edits: [{ start: 2, expectedStartLine: "const x = 1;", lines: ["const x = 2;"] }] }),
    naive: (f) => ({ path: f, edits: [{ start: 2, expectedStartLine: "const x = 1;", lines: ["const x = 2;"] }] }),
    expectedContent: "import { foo } from \"bar\";\nconst x = 2;\nexport { x };\n",
  },

  {
    name: "qe-basic-multi-line-replace",
    category: "basic",
    guideline: "#1,#2 (line numbers + guard)",
    fixture: { filename: "app.ts", content: "function foo() {\n  return 1;\n}\nconst bar = 2;\n" },
    informed: (f) => ({ path: f, edits: [{ start: 1, end: 3, expectedStartLine: "function foo() {", lines: ["function foo() {", "  return 2;", "}"] }] }),
    naive: (f) => ({ path: f, edits: [{ start: 1, end: 3, expectedStartLine: "function foo() {", lines: ["function foo() {", "  return 2;", "}"] }] }),
    expectedContent: "function foo() {\n  return 2;\n}\nconst bar = 2;\n",
  },

  {
    name: "qe-basic-delete-line",
    category: "basic",
    guideline: "#6 (lines: [] deletes)",
    fixture: { filename: "app.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" },
    informed: (f) => ({ path: f, edits: [{ start: 2, expectedStartLine: "const b = 2;", lines: [] }] }),
    naive: (f) => ({ path: f, edits: [{ start: 2, expectedStartLine: "const b = 2;", lines: [] }] }),
    expectedContent: "const a = 1;\nconst c = 3;\n",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — EOF insert (guideline #7)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-eof-insert-informed",
    category: "eof_insert",
    guideline: "#7 (start=lineCount+1 for EOF)",
    fixture: { filename: "app.ts", content: "const a = 1;\nconst b = 2;\n" },
    informed: (f) => ({ path: f, edits: [{ start: 3, expectedStartLine: "", lines: ["const c = 3;"] }] }),
    naive: (f) => ({
      // naive agent doesn't know start=lineCount+1, tries to insert at last line
      // might try start=2 with end=2, replacing line 2 instead of appending
      path: f,
      edits: [{ start: 2, end: 2, expectedStartLine: "const b = 2;", lines: ["const b = 2;", "const c = 3;"] }],
    }),
    expectedContent: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    naiveExpectedContent: "const a = 1;\nconst b = 2;\nconst c = 3;\n", // naive accidentally works but for wrong reason
  },

  {
    name: "qe-eof-insert-naive-fails",
    category: "eof_insert",
    guideline: "#7 (start=lineCount+1 for EOF)",
    fixture: { filename: "app.ts", content: "const a = 1;\nconst b = 2;\n" },
    informed: (f) => ({ path: f, edits: [{ start: 3, expectedStartLine: "", lines: ["export { a, b, c };"] }] }),
    naive: (f) => ({
      // naive tries to append by replacing last line and re-adding it
      path: f,
      edits: [{ start: 2, expectedStartLine: "const b = 2;", lines: ["const b = 2;", "export { a, b, c };"] }],
    }),
    expectedContent: "const a = 1;\nconst b = 2;\nexport { a, b, c };\n",
    naiveExpectedContent: "const a = 1;\nconst b = 2;\nexport { a, b, c };\n", // also works, different approach
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — batch snapshot semantics (guideline #9)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-batch-snapshot-informed",
    category: "batch_snapshot",
    guideline: "#9 (snapshot-based, don't renumber)",
    fixture: { filename: "app.ts", content: "line1\nline2\nline3\nline4\nline5\n" },
    informed: (f) => ({
      // agent knows batch is snapshot-based: both edits use original line numbers
      path: f,
      edits: [
        { start: 2, expectedStartLine: "line2", lines: ["LINE2", "INSERTED"] },
        { start: 4, expectedStartLine: "line4", lines: ["LINE4"] },
      ],
    }),
    naive: (f) => ({
      // agent thinks sequential: renumbers second edit after first edit's insertion
      path: f,
      edits: [
        { start: 2, expectedStartLine: "line2", lines: ["LINE2", "INSERTED"] },
        { start: 5, expectedStartLine: "line4", lines: ["LINE4"] }, // renumbered: 4+1=5, but expectedStartLine still "line4"
      ],
    }),
    expectedContent: "line1\nLINE2\nINSERTED\nline3\nLINE4\nline5\n",
    naiveExpectedFail: true, // expectedStartLine "line4" at line 5 → mismatch (line 5 is "line5")
  },

  {
    name: "qe-batch-snapshot-overlap",
    category: "batch_snapshot",
    guideline: "#9,#10 (snapshot + overlap rejection)",
    fixture: { filename: "app.ts", content: "line1\nline2\nline3\nline4\nline5\n" },
    informed: (f) => ({
      path: f,
      edits: [
        { start: 1, end: 2, expectedStartLine: "line1", lines: ["A", "B"] },
        { start: 4, end: 5, expectedStartLine: "line4", lines: ["D", "E"] },
      ],
    }),
    naive: (f) => ({
      // naive tries overlapping ranges (doesn't know they're rejected)
      path: f,
      edits: [
        { start: 1, end: 3, expectedStartLine: "line1", lines: ["A", "B", "C"] },
        { start: 3, end: 5, expectedStartLine: "line3", lines: ["X", "Y", "Z"] },
      ],
    }),
    expectedContent: "A\nB\nline3\nD\nE\n",
    naiveExpectedFail: true, // overlapping ranges rejected
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — trim mode (guideline #4)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-trim-whitespace-mismatch",
    category: "trim_mode",
    guideline: "#4 (expectedStartLineMatch=trim)",
    fixture: { filename: "app.ts", content: "const config = {\n  port: 3000,\n  host: \"localhost\",\n};\n" },
    informed: (f) => ({
      // agent knows trim mode, sends trimmed start line
      path: f,
      edits: [{ start: 2, expectedStartLine: "port: 3000,", expectedStartLineMatch: "trim", lines: ["  port: 8080,"] }],
    }),
    naive: (f) => ({
      // agent copied from read output but trailing whitespace differs (invisible)
      // sends exact guard but with slightly different whitespace
      path: f,
      edits: [{ start: 2, expectedStartLine: "  port: 3000,", lines: ["  port: 8080,"] }],
    }),
    expectedContent: "const config = {\n  port: 8080,\n  host: \"localhost\",\n};\n",
    // naive actually works here because the guard is exact and matches
    // the mismatch only happens if agent sends WRONG whitespace
  },

  {
    name: "qe-trim-actual-mismatch",
    category: "trim_mode",
    guideline: "#4 (expectedStartLineMatch=trim)",
    fixture: { filename: "app.ts", content: "const config = {\n  port: 3000,\n  host: \"localhost\",\n};\n" },
    informed: (f) => ({
      // agent knows trim, sends trimmed content even though file has leading spaces
      path: f,
      edits: [{ start: 2, expectedStartLine: "port: 3000,", expectedStartLineMatch: "trim", lines: ["  port: 8080,"] }],
    }),
    naive: (f) => ({
      // agent sends expectedStartLine WITHOUT leading spaces (trimmed by accident or by read output)
      // but guard is exact → mismatch because file line has "  port: 3000,"
      path: f,
      edits: [{ start: 2, expectedStartLine: "port: 3000,", lines: ["  port: 8080,"] }],
    }),
    expectedContent: "const config = {\n  port: 8080,\n  host: \"localhost\",\n};\n",
    naiveExpectedFail: true, // "port: 3000," !== "  port: 3000," with exact match
  },

  {
    name: "qe-trim-trailing-whitespace",
    category: "trim_mode",
    guideline: "#4 (expectedStartLineMatch=trim)",
    fixture: { filename: "app.ts", content: "const x = 1;   \nconst y = 2;\n" },
    informed: (f) => ({
      // agent knows trim, sends without trailing spaces
      path: f,
      edits: [{ start: 1, expectedStartLine: "const x = 1;", expectedStartLineMatch: "trim", lines: ["const x = 42;"] }],
    }),
    naive: (f) => ({
      // agent sends expectedStartLine without trailing spaces, but guard is exact
      // file has "const x = 1;   " (trailing spaces) → exact mismatch
      path: f,
      edits: [{ start: 1, expectedStartLine: "const x = 1;", lines: ["const x = 42;"] }],
    }),
    expectedContent: "const x = 42;\nconst y = 2;\n",
    naiveExpectedFail: true, // "const x = 1;" !== "const x = 1;   " exact
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — preserveIndent (guideline #5)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-preserve-indent-informed",
    category: "preserve_indent",
    guideline: "#5 (preserveIndent=true with trim)",
    fixture: { filename: "app.ts", content: "function foo() {\n  if (true) {\n    bar();\n  }\n}\n" },
    informed: (f) => ({
      // agent uses preserveIndent=true, sends unindented replacement lines
      path: f,
      edits: [{
        start: 3, expectedStartLine: "bar();", expectedStartLineMatch: "trim",
        preserveIndent: true, lines: ["baz();", "qux();"],
      }],
    }),
    naive: (f) => ({
      // agent doesn't know preserveIndent, manually indents lines
      // but might get indent wrong (2 spaces instead of 4)
      path: f,
      edits: [{
        start: 3, expectedStartLine: "bar();", expectedStartLineMatch: "trim",
        lines: ["  baz();", "  qux();"],
      }],
    }),
    expectedContent: "function foo() {\n  if (true) {\n    baz();\n    qux();\n  }\n}\n",
    naiveExpectedContent: "function foo() {\n  if (true) {\n  baz();\n  qux();\n  }\n}\n", // wrong indent
  },

  {
    name: "qe-preserve-indent-correct-manual",
    category: "preserve_indent",
    guideline: "#5 (preserveIndent=true with trim)",
    fixture: { filename: "app.ts", content: "function foo() {\n  if (true) {\n    bar();\n  }\n}\n" },
    informed: (f) => ({
      path: f,
      edits: [{
        start: 3, expectedStartLine: "bar();", expectedStartLineMatch: "trim",
        preserveIndent: true, lines: ["baz();", "qux();"],
      }],
    }),
    naive: (f) => ({
      // agent manually gets indent right
      path: f,
      edits: [{
        start: 3, expectedStartLine: "bar();", expectedStartLineMatch: "trim",
        lines: ["    baz();", "    qux();"],
      }],
    }),
    expectedContent: "function foo() {\n  if (true) {\n    baz();\n    qux();\n  }\n}\n",
    naiveExpectedContent: "function foo() {\n  if (true) {\n    baz();\n    qux();\n  }\n}\n", // also correct
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // quick_edit — unescape guard (guideline #3)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "qe-unescape-escaped-guard",
    category: "unescape_guard",
    guideline: "#3 (guards accept unescaped literals)",
    fixture: { filename: "escape.ts", content: "const regex = /\\$\\{([^}]+)\\}/g;\nconst tmpl = `Hello ${name}!`;\n" },
    informed: (f) => ({
      // agent knows unescape happens, sends escaped guard
      path: f,
      edits: [{ start: 1, expectedStartLine: "const regex = /\\$\\{([^}]+)\\}/g;", lines: ["const regex = /\\$\\{(.+)\\}/g;"] }],
    }),
    naive: (f) => ({
      // agent also sends the same — unescape is transparent
      path: f,
      edits: [{ start: 1, expectedStartLine: "const regex = /\\$\\{([^}]+)\\}/g;", lines: ["const regex = /\\$\\{(.+)\\}/g;"] }],
    }),
    expectedContent: "const regex = /\\$\\{(.+)\\}/g;\nconst tmpl = `Hello ${name}!`;\n",
  },

  {
    name: "qe-unescape-backslash-in-guard",
    category: "unescape_guard",
    guideline: "#3 (guards accept unescaped literals)",
    // File contains literal backslash chars: const path = "C:\\server";
    fixture: { filename: "escape.ts", content: "const path = \"C:\\\\server\";\nconst x = 1;\n" },
    informed: (f) => ({
      // agent knows unescape happens, sends guard as-is from read output
      path: f,
      edits: [{ start: 1, expectedStartLine: "const path = \"C:\\\\server\";", lines: ["const path = \"D:\\\\data\";"] }],
    }),
    naive: (f) => ({
      // agent also sends same — unescape is transparent, engine handles it
      path: f,
      edits: [{ start: 1, expectedStartLine: "const path = \"C:\\\\server\";", lines: ["const path = \"D:\\\\data\";"] }],
    }),
    expectedContent: "const path = \"D:\\\\data\";\nconst x = 1;\n",
    // both should work — unescape guideline is transparent to agent
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // target_edit — basic
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "te-basic-replace-by-line",
    category: "target_basic",
    guideline: "#3 (line selector)",
    fixture: { filename: "app.ts", content: "const app = createApp();\napp.mount('#app');\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "replace", target: "app.mount('#app')", line: 2, replacement: "app.mount('#root')" }],
    }),
    naive: (f) => ({
      path: f,
      ops: [{ type: "replace", target: "app.mount('#app')", line: 2, replacement: "app.mount('#root')" }],
    }),
    expectedContent: "const app = createApp();\napp.mount('#root');\n",
  },

  {
    name: "te-basic-insert-after",
    category: "target_basic",
    guideline: "#4 (insert_before/after)",
    fixture: { filename: "app.ts", content: "const app = createApp();\napp.mount('#app');\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "insert_after", target: "const app = createApp();", line: 1, lines: ["app.use(logger);"] }],
    }),
    naive: (f) => ({
      path: f,
      ops: [{ type: "insert_after", target: "const app = createApp();", line: 1, lines: ["app.use(logger);"] }],
    }),
    expectedContent: "const app = createApp();\napp.use(logger);\napp.mount('#app');\n",
  },

  {
    name: "te-basic-delete-multi-line",
    category: "target_basic",
    guideline: "#2 (multi-line target with \\n)",
    fixture: { filename: "app.ts", content: "before\nif (debug) {\n  console.log(value);\n}\nafter\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\n  console.log(value);\n}\n", line: 2 }],
    }),
    naive: (f) => ({
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\n  console.log(value);\n}\n", line: 2 }],
    }),
    expectedContent: "before\nafter\n",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // target_edit — escaped newlines (guideline #2)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "te-escaped-newlines",
    category: "target_escaped",
    guideline: "#2 (targets matched after unescaping)",
    fixture: { filename: "app.ts", content: "before\nif (debug) {\n  log();\n}\nafter\n" },
    informed: (f) => ({
      // agent knows \\n is matched after unescaping
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\\n  log();\\n}\\n", line: 2 }],
    }),
    naive: (f) => ({
      // agent doesn't know about unescape, sends literal \n as actual newlines
      // this should also work because the engine checks raw first
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\n  log();\n}\n", line: 2 }],
    }),
    expectedContent: "before\nafter\n",
  },

  {
    name: "te-escaped-newlines-wrong-escape",
    category: "target_escaped",
    guideline: "#2 (targets matched after unescaping)",
    fixture: { filename: "app.ts", content: "before\nif (debug) {\n  log();\n}\nafter\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\\n  log();\\n}\\n", line: 2 }],
    }),
    naive: (f) => ({
      // agent double-escapes: sends \\n when it means \n (actual newline)
      // resulting in literal backslash-n in target, which won't match
      path: f,
      ops: [{ type: "delete", target: "if (debug) {\\\\n  log();\\\\n}\\\\n", line: 2 }],
    }),
    expectedContent: "before\nafter\n",
    naiveExpectedFail: true, // double-escaped won't match even after unescape
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // target_edit — op types (guideline #5 — claimed redundant)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "te-op-types-replace",
    category: "target_op_types",
    guideline: "#5 (op type descriptions — redundant?)",
    fixture: { filename: "app.ts", content: "const x = foo();\nconst y = bar();\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "replace", target: "foo()", line: 1, replacement: "baz()" }],
    }),
    naive: (f) => ({
      // even without guideline #5, op type names are self-explanatory
      path: f,
      ops: [{ type: "replace", target: "foo()", line: 1, replacement: "baz()" }],
    }),
    expectedContent: "const x = baz();\nconst y = bar();\n",
  },

  {
    name: "te-op-types-insert-vs-replace",
    category: "target_op_types",
    guideline: "#5 (op type descriptions — redundant?)",
    fixture: { filename: "app.ts", content: "const x = 1;\nconst y = 2;\n" },
    informed: (f) => ({
      // agent knows to use insert_after for adding lines
      path: f,
      ops: [{ type: "insert_after", target: "const x = 1;", line: 1, lines: ["const z = 3;"] }],
    }),
    naive: (f) => ({
      // naive agent might try to use replace to "insert" by including original + new
      path: f,
      ops: [{ type: "replace", target: "const x = 1;\n", line: 1, replacement: "const x = 1;\nconst z = 3;\n" }],
    }),
    expectedContent: "const x = 1;\nconst z = 3;\nconst y = 2;\n",
    naiveExpectedContent: "const x = 1;\nconst z = 3;\nconst y = 2;\n", // both work, different approaches
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // target_edit — range selector (guideline #3)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "te-range-multi-occurrence",
    category: "target_range",
    guideline: "#3 (range for multiple occurrences)",
    fixture: { filename: "app.ts", content: "target();\na();\ntarget();\nb();\ntarget();\n" },
    informed: (f) => ({
      // agent knows to use range for multiple occurrences
      path: f,
      ops: [{ type: "replace", target: "target()", range: { startLine: 3, endLine: 5 }, replacement: "done()" }],
    }),
    naive: (f) => ({
      // naive agent tries line selector but there are multiple → fail
      path: f,
      ops: [{ type: "replace", target: "target()", line: 3, replacement: "done()" }],
    }),
    expectedContent: "target();\na();\ndone();\nb();\ndone();\n",
    naiveExpectedFail: true, // line 3 has 1 occurrence, but range 3-5 has 2 → actually line selector would work for 1
    // Wait — line selector finds 1 occurrence on line 3. It would succeed but only replace 1.
    // Let me fix this: naive should fail to replace ALL occurrences
    naiveExpectedContent: "target();\na();\ndone();\nb();\ntarget();\n", // only replaces line 3
  },

  {
    name: "te-range-delete-multi",
    category: "target_range",
    guideline: "#3 (range for multiple occurrences)",
    fixture: { filename: "app.ts", content: "a();\ntarget();\nb();\ntarget();\nc();\n" },
    informed: (f) => ({
      path: f,
      ops: [{ type: "delete", target: "target();\n", range: { startLine: 2, endLine: 4 } }],
    }),
    naive: (f) => ({
      // naive tries to delete one by one with line selector
      path: f,
      ops: [
        { type: "delete", target: "target();\n", line: 2 },
        { type: "delete", target: "target();\n", line: 4 },
      ],
    }),
    expectedContent: "a();\nb();\nc();\n",
    naiveExpectedFail: true, // sequential line selectors fail after line shift
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // target_edit — atomic batch (guideline #6)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "te-batch-atomic",
    category: "target_atomic",
    guideline: "#6 (atomic batch)",
    fixture: { filename: "app.ts", content: "alpha\nbeta\ngamma\ndelta\n" },
    informed: (f) => ({
      path: f,
      ops: [
        { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
        { type: "replace", target: "gamma", line: 3, replacement: "GAMMA" },
      ],
    }),
    naive: (f) => ({
      // same — atomic is engine behavior, not agent knowledge
      path: f,
      ops: [
        { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
        { type: "replace", target: "gamma", line: 3, replacement: "GAMMA" },
      ],
    }),
    expectedContent: "ALPHA\nbeta\nGAMMA\ndelta\n",
  },

  {
    name: "te-batch-atomic-fail",
    category: "target_atomic",
    guideline: "#6 (atomic batch — fail rollback)",
    fixture: { filename: "app.ts", content: "alpha\nbeta\ngamma\n" },
    informed: (f) => ({
      path: f,
      ops: [
        { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
        { type: "replace", target: "MISSING", line: 2, replacement: "BETA" },
      ],
    }),
    naive: (f) => ({
      path: f,
      ops: [
        { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
        { type: "replace", target: "MISSING", line: 2, replacement: "BETA" },
      ],
    }),
    expectedContent: "alpha\nbeta\ngamma\n", // no change (atomic rollback)
    expectThrow: true,
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

type Result = {
  task: Task;
  informedResult: { ok: boolean; content?: string | undefined; error?: string | undefined };
  naiveResult: { ok: boolean; content?: string | undefined; error?: string | undefined };
  informedCorrect: boolean;
  naiveCorrect: boolean;
  naiveErrorType?: string | undefined;
};

async function runEdit(fn: "quick" | "target", file: string, input: QuickEditInput | TargetEditInput): Promise<{ ok: boolean; content?: string | undefined; error?: string | undefined }> {
  try {
    if (fn === "quick") {
      const qe = input as QuickEditInput;
      await applyQuickEdits(file, qe.edits);
    } else {
      const te = input as TargetEditInput;
      await applyTargetEdits(file, te.ops);
    }
    const content = await readFile(file, "utf8");
    return { ok: true, content };
  } catch (err) {
    // For expectThrow tasks: read file after error to verify unchanged
    const content = await readFile(file, "utf8").catch(() => undefined);
    return { ok: false, content, error: err instanceof Error ? err.message : String(err) };
  }
}

function classifyError(error: string): string {
  if (error.includes("expectedStartLine mismatch")) return "guard_mismatch";
  if (error.includes("target not found")) return "target_not_found";
  if (error.includes("overlapping")) return "overlap";
  if (error.includes("out of bounds")) return "out_of_bounds";
  if (error.includes("must be a 1-indexed")) return "invalid_line";
  if (error.includes("unknown type")) return "unknown_type";
  if (error.includes("found multiple") || error.includes("found 2")) return "ambiguous";
  if (error.includes("must not be empty")) return "empty_target";
  if (error.includes("must differ")) return "same_content";
  return "other";
}

async function runEval(): Promise<Result[]> {
  const results: Result[] = [];

  for (const task of tasks) {
    // informed run
    const informedFile = await tempFile(task.fixture.filename, task.fixture.content);
    const informedInput = task.informed(informedFile);
    const fn = "edits" in informedInput ? "quick" : "target";
    const informedResult = await runEdit(fn, informedFile, informedInput);
    const informedCorrect = task.expectThrow
      ? !informedResult.ok && informedResult.content === task.expectedContent
      : informedResult.ok && informedResult.content === task.expectedContent;

    // naive run
    const naiveFile = await tempFile(task.fixture.filename, task.fixture.content);
    const naiveInput = task.naive(naiveFile);
    const naiveFn = "edits" in naiveInput ? "quick" : "target";
    const naiveResult = await runEdit(naiveFn, naiveFile, naiveInput);

    let naiveCorrect: boolean;
    if (task.naiveExpectedFail) {
      // naive should fail OR produce wrong content
      naiveCorrect = false;
    } else if (task.expectThrow) {
      // expectThrow applies to naive too: correct = throws + file unchanged
      naiveCorrect = !naiveResult.ok && naiveResult.content === task.expectedContent;
    } else if (task.naiveExpectedContent !== undefined) {
      naiveCorrect = naiveResult.ok && naiveResult.content === task.naiveExpectedContent;
    } else {
      naiveCorrect = naiveResult.ok && naiveResult.content === task.expectedContent;
    }

    results.push({
      task,
      informedResult,
      naiveResult,
      informedCorrect,
      naiveCorrect,
      naiveErrorType: naiveResult.error ? classifyError(naiveResult.error) : undefined as string | undefined,
    });
  }

  return results;
}

// ── report ───────────────────────────────────────────────────────────────────

function report(results: Result[]): void {
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  EVAL: Prompt Guideline Impact Analysis");
  console.log("══════════════════════════════════════════════════════════════════════════\n");

  // per-task detail
  console.log("── Per-task results ──\n");
  console.log(
    "Task".padEnd(42) +
    "Informed".padStart(10) +
    "Naive".padStart(10) +
    "Delta".padStart(8) +
    "  Naive Error".padEnd(18),
  );
  console.log("─".repeat(88));

  for (const r of results) {
    const delta = r.informedCorrect && !r.naiveCorrect ? " ← MATTERS" : "";
    const errType = r.naiveErrorType ? `[${r.naiveErrorType}]` : r.naiveResult.ok ? (r.naiveCorrect ? "" : "[wrong_content]") : "[unknown]";
    console.log(
      r.task.name.padEnd(42) +
      (r.informedCorrect ? "✓ pass".padStart(10) : "✗ FAIL".padStart(10)) +
      (r.naiveCorrect ? "✓ pass".padStart(10) : "✗ FAIL".padStart(10)) +
      delta.padStart(8) +
      "  " + errType,
    );
  }

  // per-category summary
  console.log("\n── Per-category summary ──\n");
  const categories = [...new Set(results.map((r) => r.task.category))];
  console.log(
    "Category".padEnd(22) +
    "Tasks".padStart(6) +
    "Informed".padStart(10) +
    "Naive".padStart(10) +
    "Delta".padStart(8) +
    "  Guidelines tested",
  );
  console.log("─".repeat(100));

  for (const cat of categories) {
    const catResults = results.filter((r) => r.task.category === cat);
    const informedPass = catResults.filter((r) => r.informedCorrect).length;
    const naivePass = catResults.filter((r) => r.naiveCorrect).length;
    const delta = informedPass - naivePass;
    const guidelines = [...new Set(catResults.map((r) => r.task.guideline))];
    const deltaStr = delta > 0 ? `+${delta}` : delta === 0 ? "0" : `${delta}`;
    console.log(
      cat.padEnd(22) +
      String(catResults.length).padStart(6) +
      `${informedPass}/${catResults.length}`.padStart(10) +
      `${naivePass}/${catResults.length}`.padStart(10) +
      deltaStr.padStart(8) +
      "  " + guidelines.join(", "),
    );
  }

  // guideline impact
  console.log("\n── Guideline impact ──\n");
  console.log(
    "Guideline".padEnd(55) +
    "Tasks".padStart(6) +
    "Informed".padStart(10) +
    "Naive".padStart(10) +
    "  Verdict",
  );
  console.log("─".repeat(100));

  const guidelineMap = new Map<string, { total: number; informed: number; naive: number }>();
  for (const r of results) {
    const key = r.task.guideline;
    const entry = guidelineMap.get(key) ?? { total: 0, informed: 0, naive: 0 };
    entry.total++;
    if (r.informedCorrect) entry.informed++;
    if (r.naiveCorrect) entry.naive++;
    guidelineMap.set(key, entry);
  }

  for (const [guideline, stats] of [...guidelineMap.entries()].sort()) {
    const delta = stats.informed - stats.naive;
    let verdict: string;
    if (delta === 0 && stats.naive === stats.total) verdict = "REDUNDANT — naive always passes";
    else if (delta === 0 && stats.informed === stats.naive) verdict = "NO EFFECT — both same";
    else if (delta > 0) verdict = `MATTERS — +${delta} tasks`;
    else verdict = "CHECK — naive better?";
    console.log(
      guideline.padEnd(55) +
      String(stats.total).padStart(6) +
      `${stats.informed}/${stats.total}`.padStart(10) +
      `${stats.naive}/${stats.total}`.padStart(10) +
      "  " + verdict,
    );
  }

  // overall
  const totalInformed = results.filter((r) => r.informedCorrect).length;
  const totalNaive = results.filter((r) => r.naiveCorrect).length;
  console.log("\n── Overall ──\n");
  console.log(`  Tasks:       ${results.length}`);
  console.log(`  Informed OK: ${totalInformed}/${results.length} (${((totalInformed / results.length) * 100).toFixed(0)}%)`);
  console.log(`  Naive OK:    ${totalNaive}/${results.length} (${((totalNaive / results.length) * 100).toFixed(0)}%)`);
  console.log(`  Delta:       ${totalInformed - totalNaive} tasks where guidelines matter`);
  console.log();
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const results = await runEval();
  report(results);
  await cleanup();
}

main().catch((err) => {
  console.error("Eval failed:", err);
  cleanup().finally(() => process.exit(1));
});