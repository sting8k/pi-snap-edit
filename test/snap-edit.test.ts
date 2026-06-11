import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import snapEditExtension, {
  applyQuickEdits,
  applySubstituteEdits,
  applyTargetEdits,
  splitLines,
  numberReadText,
  summarizeQuickEditOutput,
  preferQuickEditTools,
  type Edit,
} from "../src/index.js";

const tempDirs: string[] = [];

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-snap-edit-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

async function assertUtf8BomContent(file: string, expectedTextAfterBom: string): Promise<void> {
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
  assert.equal(bytes.subarray(3).toString("utf8"), expectedTextAfterBom);
}

function editFor(lines: string[], startLine: number, endLine: number, replacementLines: string[]): Edit {
  return {
    expectedStartLine: lines[startLine - 1] ?? "",
    start: startLine,
    end: endLine,
    lines: replacementLines,
  };
}



afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("text helpers", () => {
  it("splits text while preserving editable lines semantics", () => {
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("one\n"), ["one"]);
    assert.deepEqual(splitLines("one\ntwo"), ["one", "two"]);
    assert.deepEqual(splitLines("one\r\ntwo\r\n"), ["one", "two"]);
  });

  it("numbers CRLF read output without hidden carriage returns", () => {
    assert.equal(numberReadText("one\r\ntwo\r\n"), "1| one\n2| two");
    assert.equal(
      numberReadText("one\r\ntwo\r\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]", { totalLineCount: 3 }),
      "1| one\n2| two\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]",
    );
  });

  it("numbers UTF-8 BOM read output without exposing a hidden first-line character", () => {
    assert.equal(numberReadText("\uFEFFone\ntwo\n"), "1| one\n2| two");
  });

  it("preserves content FEFF after the UTF-8 BOM in read output", () => {
    assert.equal(numberReadText("\uFEFF\uFEFFone\n"), "1| \uFEFFone");
  });

  it("preserves FEFF content when numbering a later read chunk", () => {
    assert.equal(numberReadText("\uFEFFmiddle\n", { startLine: 2 }), "2| \uFEFFmiddle");
  });
});


describe("quick-edit renderer helpers", () => {
  it("summarizes compact quick-edit diffs", () => {
    const text = "── diff ──\n:2\n- old\n+ new\n\n1| alpha";
    assert.deepEqual(summarizeQuickEditOutput(text), { additions: 1, removals: 1, hasDiff: true });
  });

  it("handles context-only quick-edit output", () => {
    assert.deepEqual(summarizeQuickEditOutput("1| alpha"), { additions: 0, removals: 0, hasDiff: false });
  });
  it("prefers quick_edit by removing disabled edit tools from active tools", () => {
    assert.deepEqual(preferQuickEditTools(["read", "edit", "bash"]), ["read", "bash", "quick_edit", "target_edit"]);
    assert.deepEqual(preferQuickEditTools(["read", "quick_edit", "substitute_edit", "edit"]), ["read", "quick_edit", "target_edit"]);
  });
});

describe("quick edits", () => {
  it("applies single-line replacement and preserves trailing LF", async () => {
    const file = await tempFile("sample.ts", "one\ntwo\nthree\n");
    const result = await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["TWO"] }]);

    assert.equal(await readFile(file, "utf8"), "one\nTWO\nthree\n");
    assert.match(result, /── diff ──/);
    assert.match(result, /- two/);
    assert.match(result, /\+ TWO/);
    assert.match(result, /1\| one\n2\| TWO\n3\| three/);
  });

  it("checks expectedStartLine before editing", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");

    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["TWO"] }]);

    assert.equal(await readFile(file, "utf8"), "one\nTWO\nthree\n");
  });

  it("rejects expectedStartLine mismatch atomically", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");

    await assert.rejects(
      () => applyQuickEdits(file, [
        { start: 1, expectedStartLine: "one", lines: ["ONE"] },
        { start: 1, expectedStartLine: "one", lines: ["ONE"] },
        { start: 2, expectedStartLine: "not two", lines: ["TWO"] },
      ]),
      /edit\[2\] expectedStartLine mismatch at line 2; no edits were applied[\s\S]*Read the file to see current content/,
    );
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("suggests close start-line matches without editing", async () => {
    const file = await tempFile("sample.txt", "const enabled = false;\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, expectedStartLine: "const enabled = fasle;", lines: ["const enabled = true;"] }]),
      /Close start-line matches:[\s\S]*line 1: const enabled = false;[\s\S]*expectedStartLineMatch="trim"/,
    );
    assert.equal(await readFile(file, "utf8"), "const enabled = false;\n");
  });

  it("accepts expectedStartLine with JSON escape sequences at guard time", async () => {
    const file = await tempFile("sample.txt", "foo\tbar\n");

    await applyQuickEdits(file, [{ start: 1, expectedStartLine: "foo\\tbar", lines: ["FOO"] }]);

    assert.equal(await readFile(file, "utf8"), "FOO\n");
  });

  it("keeps exact expectedStartLine matching by default", async () => {
    const file = await tempFile("sample.txt", "  value = false\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, expectedStartLine: "value = false", lines: ["value = true"] }]),
      /expectedStartLine mismatch[\s\S]*Expected start line matched by trim at line\(s\): 1\.[\s\S]*expectedStartLineMatch="trim"/,
    );
    assert.equal(await readFile(file, "utf8"), "  value = false\n");
  });

  it("supports trimmed guards with preserved indentation", async () => {
    const file = await tempFile("sample.txt", "function run() {\n\tif (enabled) {\n\t\toldCall();\n\t}\n}\n");

    await applyQuickEdits(file, [
      {
        start: 2,
        end: 4,
        expectedStartLine: "if (enabled) {",
        expectedStartLineMatch: "trim",
        preserveIndent: true,
        lines: ["if (ready) {", "  newCall();", "}"],
      },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n\tif (ready) {\n\t  newCall();\n\t}\n}\n");
  });

  it("shows nearby context when expectedStartLine moved elsewhere", async () => {
    const file = await tempFile("sample.txt", "one\ninserted\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["TWO"] }]),
      /expectedStartLine mismatch at line 2[\s\S]*Expected start line found at line\(s\): 3\.[\s\S]*3\| two[\s\S]*8\| seven/,
    );
    assert.equal(await readFile(file, "utf8"), "one\ninserted\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  });
  it("applies multi-line replacements in reverse order without shifting later lines", async () => {
    const original = ["a", "b", "c", "d", "e"];
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);

    await applyQuickEdits(file, [
      editFor(original, 2, 3, ["B", "C", "CC"]),
      editFor(original, 5, 5, ["E"]),
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nB\nC\nCC\nd\nE\n");
  });

  it("deletes a line or range when lines is empty", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 3, [])]);

    assert.equal(await readFile(file, "utf8"), "a\nd");
  });

  it("replaces with a blank line when lines contains an empty string", async () => {
    const original = ["a", "b", "c"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 2, [""])]);

    assert.equal(await readFile(file, "utf8"), "a\n\nc");
  });

  it("preserves CRLF and absence of trailing newline", async () => {
    const original = ["first", "second", "third"];
    const file = await tempFile("sample.txt", "first\r\nsecond\r\nthird");
    await applyQuickEdits(file, [editFor(original, 2, 2, ["SECOND", "inserted"])]);

    assert.equal(await readFile(file, "utf8"), "first\r\nSECOND\r\ninserted\r\nthird");
  });

  it("preserves a single UTF-8 BOM when editing the first line", async () => {
    const file = await tempFile("sample.txt", "\uFEFFone\ntwo\n");

    await applyQuickEdits(file, [{ start: 1, expectedStartLine: "one", lines: ["ONE"] }]);

    await assertUtf8BomContent(file, "ONE\ntwo\n");
  });

  it("preserves content FEFF immediately after the UTF-8 BOM", async () => {
    const file = await tempFile("sample.txt", "\uFEFF\uFEFFone\ntwo\n");

    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["TWO"] }]);

    await assertUtf8BomContent(file, "\uFEFFone\nTWO\n");
  });

  it("allows adding a leading FEFF to a file that did not already have one", async () => {
    const file = await tempFile("sample.txt", "one\n");

    await applyQuickEdits(file, [{ start: 1, expectedStartLine: "one", lines: ["\uFEFFONE"] }]);

    await assertUtf8BomContent(file, "ONE\n");
  });

  it("accepts expectedStartLine copied from numbered CRLF read output", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree\r\n");
    const numbered = numberReadText(await readFile(file, "utf8"));
    const expectedStartLine = numbered.split("\n")[1]!.replace(/^\s*\d+\| /, "");

    assert.equal(expectedStartLine, "two");

    await applyQuickEdits(file, [{ start: 2, expectedStartLine, lines: ["TWO"] }]);

    assert.equal(await readFile(file, "utf8"), "one\r\nTWO\r\nthree\r\n");
  });

  it("inserts at EOF with start equal to lineCount plus one", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\n");
    await applyQuickEdits(file, [{ start: 3, expectedStartLine: "", lines: ["three"] }]);

    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("inserts into an empty file with start line 1", async () => {
    const file = await tempFile("sample.txt", "");
    await applyQuickEdits(file, [{ start: 1, expectedStartLine: "", lines: ["first"] }]);

    assert.equal(await readFile(file, "utf8"), "first");
  });

  it("deletes the only trailing-newline line into an empty file", async () => {
    const file = await tempFile("sample.txt", "only\n");
    await applyQuickEdits(file, [{ start: 1, expectedStartLine: "only", lines: [] }]);

    assert.equal(await readFile(file, "utf8"), "");
  });

  it("handles unicode content and replacements", async () => {
    const original = ["hello", "こんにちは", "bye"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 2, ["こんばんは"])]);

    assert.equal(await readFile(file, "utf8"), "hello\nこんばんは\nbye");
  });


  it("edits duplicate lines directly by line number", async () => {
    const original = ["start", "dup", "dup", "end"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await applyQuickEdits(file, [{ start: 3, expectedStartLine: "dup", lines: ["DUP"] }]);

    assert.equal(await readFile(file, "utf8"), "start\ndup\nDUP\nend");
  });

  it("renders duplicate lines plainly in quick_edit diff output", async () => {
    const original = ["before", "dup", "dup", "after"];
    const file = await tempFile("sample.txt", original.join("\n"));

    const result = await applyQuickEdits(file, [
      { start: 1, end: 4, expectedStartLine: "before", lines: ["before", "dup changed", "dup", "after"] },
    ]);

    assert.match(result, /- dup\n- dup/);
    assert.equal(await readFile(file, "utf8"), "before\ndup changed\ndup\nafter");
  });

  it("rejects overlapping ranges atomically", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      async () => applyQuickEdits(file, [editFor(original, 1, 3, ["x"]), editFor(original, 3, 4, ["y"])]),
      /overlapping edit ranges/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects out-of-bounds and reversed ranges atomically", async () => {
    const original = ["a", "b"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      async () => applyQuickEdits(file, [{ start: 4, expectedStartLine: "", lines: ["x"] }]),
      /out of bounds/,
    );
    await assert.rejects(
      async () => applyQuickEdits(file, [{ start: 2, end: 1, expectedStartLine: "b", lines: ["x"] }]),
      /end < start/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });
});

describe("substitute edits", () => {
  it("applies ordered substitutions inside a required line range", async () => {
    const file = await tempFile(
      "sample.ts",
      [
        "function one() {",
        "  logger.debug(debugEnabled);",
        "}",
        "function two() {",
        "  logger.debug(debugEnabled);",
        "}",
      ].join("\n") + "\n",
    );

    const result = await applySubstituteEdits(file, 4, 6, [
      { old: "logger.debug", new: "logger.trace", count: 1 },
      { old: "debugEnabled", new: "traceEnabled", count: 1 },
    ]);

    assert.match(result, /logger\.trace/);
    assert.equal(
      await readFile(file, "utf8"),
      [
        "function one() {",
        "  logger.debug(debugEnabled);",
        "}",
        "function two() {",
        "  logger.trace(traceEnabled);",
        "}",
      ].join("\n") + "\n",
    );
  });

  it("rejects count mismatch atomically", async () => {
    const original = "one\ntwo two\nthree\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applySubstituteEdits(file, 1, 3, []),
      /substitutions must contain at least one replacement/,
    );

    await assert.rejects(
      async () => applySubstituteEdits(file, 1, 3, [{ old: "two", new: "TWO", count: 1 }]),
      /expected 1 occurrence\(s\).*found 2/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });


  it("rejects invalid ranges and multi-line substitutions", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\n");

    await assert.rejects(
      async () => applySubstituteEdits(file, 3, 3, [{ old: "x", new: "y", count: 1 }]),
      /out of bounds/,
    );
    await assert.rejects(
      async () => applySubstituteEdits(file, 1, 2, [{ old: "", new: "x", count: 1 }]),
      /old must not be empty/,
    );
    await assert.rejects(
      async () => applySubstituteEdits(file, 1, 2, [{ old: "one", new: "ONE\nTWO", count: 1 }]),
      /single-line/,
    );
  });

  it("preserves CRLF and no-trailing-newline files", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree");
    await applySubstituteEdits(file, 2, 2, [{ old: "two", new: "TWO", count: 1 }]);

    assert.equal(await readFile(file, "utf8"), "one\r\nTWO\r\nthree");
  });

  it("preserves a single UTF-8 BOM during substitutions", async () => {
    const file = await tempFile("sample.txt", "\uFEFFone\ntwo\n");

    await applySubstituteEdits(file, 1, 1, [{ old: "one", new: "ONE", count: 1 }]);

    await assertUtf8BomContent(file, "ONE\ntwo\n");
  });
});

describe("target edits", () => {
  it("replaces exact target text by line and returns numbered context", async () => {
    const file = await tempFile("sample.ts", "const app = createApp();\napp.mount('#app');\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "app.mount('#app')", line: 2, replacement: "app.mount('#root')" },
    ]);

    assert.equal(await readFile(file, "utf8"), "const app = createApp();\napp.mount('#root');\n");
    assert.match(result, /── diff ──/);
    assert.match(result, /- app\.mount\('#app'\);/);
    assert.match(result, /\+ app\.mount\('#root'\);/);
    assert.match(result, /1\| const app = createApp\(\);\n2\| app\.mount\('#root'\);/);
  });

  it("preserves a single UTF-8 BOM when target replacement starts at the first line", async () => {
    const file = await tempFile("sample.txt", "\uFEFFone\ntwo\n");

    await applyTargetEdits(file, [
      { type: "replace", target: "one", line: 1, replacement: "ONE" },
    ]);

    await assertUtf8BomContent(file, "ONE\ntwo\n");
  });

  it("inserts full lines after the line containing the target", async () => {
    const file = await tempFile("sample.ts", "const app = createApp();\napp.mount('#app');\n");
    await applyTargetEdits(file, [
      { type: "insert_after", target: "const app = createApp();", line: 1, lines: ["app.use(logger);"] },
    ]);

    assert.equal(await readFile(file, "utf8"), "const app = createApp();\napp.use(logger);\napp.mount('#app');\n");
  });

  it("inserts full lines before the line containing the target", async () => {
    const file = await tempFile("sample.ts", "const app = createApp();\napp.mount('#app');\n");
    await applyTargetEdits(file, [
      { type: "insert_before", target: "app.mount('#app');", line: 2, lines: ["app.use(logger);"] },
    ]);

    assert.equal(await readFile(file, "utf8"), "const app = createApp();\napp.use(logger);\napp.mount('#app');\n");
  });

  it("deletes multi-line target text by line", async () => {
    const original = [
      "before",
      "if (debug) {",
      "  console.log(value);",
      "}",
      "after",
    ].join("\n");
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "delete", target: "if (debug) {\n  console.log(value);\n}\n", line: 2 },
    ]);

    assert.equal(await readFile(file, "utf8"), "before\nafter");
  });

  it("replaces every occurrence inside a line range", async () => {
    const file = await tempFile("sample.ts", [
      "one();",
      "target();",
      "two();",
      "target();",
      "three();",
    ].join("\n") + "\n");
    await applyTargetEdits(file, [
      { type: "replace", target: "target()", range: { startLine: 3, endLine: 5 }, replacement: "selected()" },
    ]);

    assert.equal(await readFile(file, "utf8"), "one();\ntarget();\ntwo();\nselected();\nthree();\n");
  });

  it("deletes every occurrence inside a line range", async () => {
    const file = await tempFile("sample.ts", [
      "a();",
      "target();",
      "b();",
      "target();",
      "c();",
    ].join("\n") + "\n");
    await applyTargetEdits(file, [
      { type: "delete", target: "target();\n", range: { startLine: 2, endLine: 4 } },
    ]);

    assert.equal(await readFile(file, "utf8"), "a();\nb();\nc();\n");
  });

  it("rejects missing target with occurrence list", async () => {
    const file = await tempFile("sample.txt", "alpha\nbeta\ngamma\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "delta", line: 1, replacement: "DELTA" },
      ]),
      /target not found/
    );
  });

  it("finds multi-line target when JSON sends escaped newlines", async () => {
    const file = await tempFile("sample.ts", "before\nif (debug) {\n  log();\n}\nafter\n");
    await applyTargetEdits(file, [
      {
        type: "delete",
        target: "if (debug) {\\n  log();\\n}\\n",
        line: 2,
      },
    ]);

    assert.equal(await readFile(file, "utf8"), "before\nafter\n");
  });

  it("prefers raw target matches over unescaped fallback matches on a line", async () => {
    const file = await tempFile("sample.txt", "path \\\\ server\n");

    await applyTargetEdits(file, [
      { type: "replace", target: "\\\\", line: 1, replacement: "/" },
    ]);

    assert.equal(await readFile(file, "utf8"), "path / server\n");
  });

  it("prefers raw target matches over unescaped fallback matches in a range", async () => {
    const file = await tempFile("sample.txt", "\\\\x\n");

    await applyTargetEdits(file, [
      { type: "replace", target: "\\\\", range: { startLine: 1, endLine: 1 }, replacement: "ABC" },
    ]);

    assert.equal(await readFile(file, "utf8"), "ABCx\n");
  });

  it("suggests close target matches when target is missing", async () => {
    const original = "alpha\nconst enabled = false;\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "const enabled = fasle;", line: 2, replacement: "const enabled = true;" },
      ]),
      /target not found[\s\S]*close target matches:[\s\S]*line 2: const enabled = false;/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("rejects ambiguous line with occurrence list", async () => {
    const file = await tempFile("sample.txt", "a\nwrap(wrap)\nb\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "wrap", line: 2, replacement: "WRAP" },
      ]),
      /expected 1 occurrence.*on line 2 but found 2/
    );
  });
  it("rejects invalid line selectors and unknown op types", async () => {
    const original = "one\ntarget\nthree\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", line: "2", replacement: "TARGET" } as any,
      ]),
      /line must be a 1-indexed line number/
    );
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", line: 99, replacement: "TARGET" },
      ]),
      /out of bounds/
    );
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "deleet", target: "target", line: 2 } as any,
      ]),
      /unknown type/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("rejects invalid ranges", async () => {
    const file = await tempFile("sample.txt", "one\ntarget\nthree\n");

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", range: { startLine: 3, endLine: 2 }, replacement: "TARGET" },
      ]),
      /invalid range/
    );
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", range: { startLine: 1, endLine: 999 }, replacement: "TARGET" },
      ]),
      /out of bounds/
    );
    assert.equal(await readFile(file, "utf8"), "one\ntarget\nthree\n");
  });

  it("rejects range with no matches", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "four", range: { startLine: 1, endLine: 3 }, replacement: "FOUR" },
      ]),
      /target not found/
    );
  });

  it("rejects selector failures atomically", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
        { type: "replace", target: "missing", line: 2, replacement: "MISSING" },
      ]),
      /target not found/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("preserves CRLF and no-trailing-newline files", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree");
    await applyTargetEdits(file, [
      { type: "insert_after", target: "two", line: 2, lines: ["TWO-AND-A-HALF"] },
      { type: "replace", target: "three", line: 4, replacement: "THREE" },
    ]);

    assert.equal(await readFile(file, "utf8"), "one\r\ntwo\r\nTWO-AND-A-HALF\r\nTHREE");
  });

  it("reports earlier changes at final line positions after later line-shifting ops", async () => {
    const original = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);

    const result = await applyTargetEdits(file, [
      { type: "replace", target: "line10", line: 10, replacement: "LINE10" },
      { type: "insert_before", target: "line1", line: 1, lines: Array.from({ length: 10 }, (_, index) => `inserted-${index + 1}`) },
    ]);

    assert.equal(
      await readFile(file, "utf8"),
      [...Array.from({ length: 10 }, (_, index) => `inserted-${index + 1}`), ...original.slice(0, 9), "LINE10", ...original.slice(10)].join("\n") + "\n",
    );
    assert.match(result, /:20\n- line10\n\+ LINE10/);
    assert.match(result, /20\| LINE10/);
  });

});
