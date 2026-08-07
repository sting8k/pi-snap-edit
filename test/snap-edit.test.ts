import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import snapEditExtension, {
  applyQuickEdits,
  applyTargetEdits,
  parseSnapEditError,
  SnapEditError,
  SNAP_EDIT_ERROR_MARKER,
  splitLines,
  numberReadText,
  summarizeQuickEditOutput,
  preferQuickEditTools,
  type Edit,
} from "../src/index.js";
import { QuickEditParams } from "../src/schemas.js";

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

  it("summarizes additions/removals with leading notes", () => {
    const text = "matched via trim (indentation differed)\n\n── diff ──\n:2\n- old\n+ new\n\n1| alpha";
    assert.deepEqual(summarizeQuickEditOutput(text), { additions: 1, removals: 1, hasDiff: true });
  });
  it("prefers quick_edit and cleans legacy substitute_edit from saved active tools", () => {
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

  it("reports a post-edit range header for a multi-line replace that grows the file", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const result = await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a", "b", "c"] }]);

    assert.equal(await readFile(file, "utf8"), "one\na\nb\nc\nthree\n");
    assert.match(result, /^:2-4$/m);
    assert.match(result, /\+ a\n\+ b\n\+ c/);
  });

  it("reports a post-edit point header for a pure deletion", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const result = await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: [] }]);

    assert.equal(await readFile(file, "utf8"), "one\nthree\n");
    assert.match(result, /^:2$/m);
    assert.match(result, /- two/);
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

  it("splits an embedded \n inside a lines entry while keeping the file CRLF", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree\r\n");
    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a\nb"] }]);

    assert.equal(await readFile(file, "utf8"), "one\r\na\r\nb\r\nthree\r\n");
  });

  it("splits an embedded CRLF (\r\n) inside a lines entry", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a\r\nb"] }]);

    assert.equal(await readFile(file, "utf8"), "one\na\nb\nthree\n");
  });

  it("keeps a literal backslash-n (two characters) intact in a lines entry", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a\\nb"] }]);

    assert.equal(await readFile(file, "utf8"), "one\na\\nb\nthree\n");
  });

  it("reports the true post-split line count in diff/context output", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const report = await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a\nb"] }]);

    assert.equal(await readFile(file, "utf8"), "one\na\nb\nthree\n");
    assert.ok(report.includes("+ a\n+ b"), `expected split diff lines, got:\n${report}`);
    assert.ok(!report.includes("+ a\nb"), "split lines must not be reported as a single line");
  });

  it("leaves LF files unaffected by newline-normalization", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    await applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["a", "b"] }]);

    assert.equal(await readFile(file, "utf8"), "one\na\nb\nthree\n");
  });

  it("does not suggest indent_tolerant for the start guard when trim also finds nothing", async () => {
    const file = await tempFile("sample.txt", "alpha\nbeta\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, expectedStartLine: "gamma", lines: ["GAMMA"] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_START_LINE_MISMATCH");
        assert.equal(failure.suggested, undefined);
        return true;
      },
    );
  });

  it("suggests indent_tolerant for the start guard when trim finds a match", async () => {
    const file = await tempFile("sample.txt", "  value = false\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, expectedStartLine: "value = false", lines: ["value = true"] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_START_LINE_MISMATCH");
        assert.deepEqual(failure.suggested, { whitespace: "indent_tolerant" });
        return true;
      },
    );
  });

  it("does not suggest indent_tolerant for the end guard when trim also finds nothing", async () => {
    const file = await tempFile("sample.txt", "function foo() {\n  return 1;\n}\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{
        start: 1,
        end: 3,
        expectedStartLine: "function foo() {",
        expectedEndLine: "};",
        lines: ["function foo() {", "  return 2;", "}"],
      }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_END_LINE_MISMATCH");
        assert.equal(failure.suggested, undefined);
        return true;
      },
    );
  });

  it("suggests indent_tolerant for the end guard when trim matches the end line", async () => {
    const file = await tempFile("sample.txt", "function foo() {\n  return 1;\n};  \n");
    await assert.rejects(
      () => applyQuickEdits(file, [{
        start: 1,
        end: 3,
        expectedStartLine: "function foo() {",
        expectedEndLine: "};",
        lines: ["function foo() {", "  return 2;", "}"],
      }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_END_LINE_MISMATCH");
        assert.deepEqual(failure.suggested, { whitespace: "indent_tolerant" });
        return true;
      },
    );
  });

  it("preserveIndent does not prefix indent onto blank or whitespace-only replacement lines", async () => {
    const file = await tempFile("sample.txt", "function run() {\n\tdoThing();\n}\n");
    await applyQuickEdits(file, [
      {
        start: 2,
        expectedStartLine: "doThing();",
        expectedStartLineMatch: "trim",
        preserveIndent: true,
        lines: ["first()", "", "  ", "last()"],
      },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n\tfirst()\n\n  \n\tlast()\n}\n");
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

  it("shows first/last line near matches for multi-line target not found", async () => {
    const original = "alpha\nif (debug) {\n  console.log(val);\n}\ngamma\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "if (debug) {\n  console.log(value);\n}\n", line: 2, replacement: "if (debug) {\n  console.log(v);\n}\n" },
      ]),
      /target not found[\s\S]*first line near matches:[\s\S]*line 2: if \(debug\) \{/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("shows anchor block candidates for multi-line target not found", async () => {
    const original = "alpha\nif (debug) {\n  console.log(val);\n}\ngamma\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "if (debug) {\n  console.log(wrong);\n}\n", line: 2, replacement: "REPLACED" },
      ]),
      /target not found[\s\S]*anchor block candidates[\s\S]*lines 2-4:/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("shows multi-line hints for unescaped target when JSON sends escaped newlines", async () => {
    const original = "before\nif (debug) {\n  log();\n}\nafter\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "delete", target: "if (debug) {\\n  wrong();\\n}\\n", line: 2 },
      ]),
      /target not found[\s\S]*first line near matches:[\s\S]*line 2: if \(debug\) \{/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("gives clean error without extra sections when no near matches exist", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "delta\nepsilon\nzeta\n", line: 1, replacement: "DELTA" },
      ]),
      (err: Error) => {
        assert.match(err.message, /target not found/);
        assert.doesNotMatch(err.message, /first line near matches/);
        assert.doesNotMatch(err.message, /anchor block candidates/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("shows first/last line near matches for multi-line target not found", async () => {
    const original = "alpha\nif (debug) {\n  console.log(val);\n}\ngamma\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "if (debug) {\n  console.log(value);\n}\n", line: 2, replacement: "if (debug) {\n  console.log(v);\n}\n" },
      ]),
      /target not found[\s\S]*first line near matches:[\s\S]*line 2: if \(debug\) \{/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("shows anchor block candidates for multi-line target not found", async () => {
    const original = "alpha\nif (debug) {\n  console.log(val);\n}\ngamma\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "if (debug) {\n  console.log(wrong);\n}\n", line: 2, replacement: "REPLACED" },
      ]),
      /target not found[\s\S]*anchor block candidates[\s\S]*lines 2-4:/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("shows multi-line hints for unescaped target when JSON sends escaped newlines", async () => {
    const original = "before\nif (debug) {\n  log();\n}\nafter\n";
    const file = await tempFile("sample.ts", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "delete", target: "if (debug) {\\n  wrong();\\n}\\n", line: 2 },
      ]),
      /target not found[\s\S]*first line near matches:[\s\S]*line 2: if \(debug\) \{/
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("gives clean error without extra sections when no near matches exist", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "delta\nepsilon\nzeta\n", line: 1, replacement: "DELTA" },
      ]),
      (err: Error) => {
        assert.match(err.message, /target not found/);
        assert.doesNotMatch(err.message, /first line near matches/);
        assert.doesNotMatch(err.message, /anchor block candidates/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("replaces a unique target without line or range selector", async () => {
    const original = "alpha\nconst app = createApp();\ngamma\n";
    const file = await tempFile("sample.ts", original);

    const result = await applyTargetEdits(file, [
      { type: "replace", target: "const app = createApp();", replacement: "const app = createApp({ debug: true });" },
    ]);

    assert.equal(await readFile(file, "utf8"), "alpha\nconst app = createApp({ debug: true });\ngamma\n");
    assert.match(result, /- const app = createApp\(\);/);
    assert.match(result, /\+ const app = createApp\({ debug: true }\);/);
  });

  it("rejects ambiguous target when no selector is provided", async () => {
    const original = "target\nalpha\ntarget\nbeta\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", replacement: "TARGET" },
      ]),
      /occurs 2 times in the file.*provide line or range/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("allows both line and range when an occurrence intersects the line", async () => {
    const original = "alpha\ntarget\nbeta\ntarget\ngamma\n";
    const file = await tempFile("sample.txt", original);

    const result = await applyTargetEdits(file, [
      { type: "replace", target: "target", line: 2, range: { startLine: 2, endLine: 4 }, replacement: "TARGET" },
    ]);

    assert.equal(await readFile(file, "utf8"), "alpha\nTARGET\nbeta\nTARGET\ngamma\n");
    assert.match(result, /2\| TARGET/);
  });

  it("rejects line+range when no selected occurrence intersects the line", async () => {
    const original = "alpha\ntarget\nbeta\ntarget\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "target", line: 5, range: { startLine: 2, endLine: 4 }, replacement: "TARGET" },
      ]),
      /range 2-4 selected .* occurrence\(s\) .* but none intersect line 5/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("replaces a target with matchMode=trim ignoring leading/trailing whitespace", async () => {
    const original = "const config = {\n  port: 3000,\n};\n";
    const file = await tempFile("sample.ts", original);

    const result = await applyTargetEdits(file, [
      { type: "replace", target: "port: 3000,", line: 2, matchMode: "trim", replacement: "port: 8080," },
    ]);

    assert.equal(await readFile(file, "utf8"), "const config = {\n  port: 8080,\n};\n");
    assert.match(result, /2\|\s+port: 8080/);
  });

  it("trim replace does not consume the following line", async () => {
    const original = "function foo() {\n  bar();\n}\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "replace", target: "  bar();", line: 2, matchMode: "trim", replacement: "  baz();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n  baz();\n}\n");
  });

  it("preserves original indentation when replacing with matchMode=trim", async () => {
    const original = "function foo() {\n    bar();\n}\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "replace", target: "  bar();", line: 2, matchMode: "trim", replacement: "  baz();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n    baz();\n}\n");
  });

  it("replaces multi-line target with matchMode=trim", async () => {
    const original = "alpha\nif (debug) {\n  console.log(val);\n}\ngamma\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "replace", target: "if (debug) {\nconsole.log(val);\n}\n", line: 2, matchMode: "trim", replacement: "if (debug) {\n  console.log(result);\n}\n" },
    ]);

    assert.equal(await readFile(file, "utf8"), "alpha\nif (debug) {\n  console.log(result);\n}\ngamma\n");
  });

  it("deletes the whole line for a matchMode=trim target", async () => {
    // A trimmed match covers a whole line by definition, so delete removes the
    // full line rather than leaving an orphaned indentation-only line.
    const original = "function foo() {\n    bar();\n}\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "delete", target: "  bar();", line: 2, matchMode: "trim" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n}\n");
  });

  it("auto-trim delete removes the whole line", async () => {
    const original = "const keep = 1;\n\tconst target = 2;\nconst tail = 3;\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "delete", target: "    const target = 2;" },
    ]);

    assert.equal(await readFile(file, "utf8"), "const keep = 1;\nconst tail = 3;\n");
  });

  it("auto-trim delete matches explicit matchMode=trim delete byte-identical", async () => {
    const original = "const keep = 1;\n\tconst target = 2;\nconst tail = 3;\n";
    const auto = await tempFile("sample.ts", original);
    const explicit = await tempFile("sample.ts", original);

    await applyTargetEdits(auto, [{ type: "delete", target: "    const target = 2;" }]);
    await applyTargetEdits(explicit, [{ type: "delete", target: "    const target = 2;", matchMode: "trim" }]);

    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
  });

  it("exact delete keeps literal substring semantics (no whole-line eating)", async () => {
    const original = "foo bar foo\n";
    const file = await tempFile("sample.txt", original);

    await applyTargetEdits(file, [{ type: "delete", target: "bar" }]);

    assert.equal(await readFile(file, "utf8"), "foo  foo\n");
  });

  it("trim delete of the last line without a trailing newline leaves no dangling newline", async () => {
    const file = await tempFile("sample.txt", "a\n\tb");
    await applyTargetEdits(file, [{ type: "delete", target: "    b" }]);

    assert.equal(await readFile(file, "utf8"), "a");
  });

  it("trim delete of the last line keeps the file trailing newline", async () => {
    const file = await tempFile("sample.txt", "a\n\tb\n");
    await applyTargetEdits(file, [{ type: "delete", target: "    b" }]);

    assert.equal(await readFile(file, "utf8"), "a\n");
  });

  it("trim delete of a multi-line block removes every line", async () => {
    const file = await tempFile("sample.ts", "a\n\tb\n\tc\nd\n");
    await applyTargetEdits(file, [{ type: "delete", target: "    b\n    c" }]);

    assert.equal(await readFile(file, "utf8"), "a\nd\n");
  });

  it("trim delete of multiple occurrences in a range removes each line", async () => {
    const file = await tempFile("sample.txt", "a\n\tb\nx\n\tb\ny\n");
    await applyTargetEdits(file, [
      { type: "delete", target: "    b", range: { startLine: 2, endLine: 4 } },
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nx\ny\n");
  });

  it("trim delete preserves CRLF bytes", async () => {
    const file = await tempFile("sample.txt", "a\r\n\tb\r\nc\r\n");
    await applyTargetEdits(file, [{ type: "delete", target: "    b" }]);

    assert.equal(await readFile(file, "utf8"), "a\r\nc\r\n");
  });

  it("trim delete of the only line yields an empty file", async () => {
    const file = await tempFile("sample.txt", "\t\ta");
    await applyTargetEdits(file, [{ type: "delete", target: "    a" }]);

    assert.equal(await readFile(file, "utf8"), "");
  });


  it("rejects whitespace-only target with matchMode=trim without editing", async () => {
    const original = "alpha\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: " \n", matchMode: "trim", replacement: "beta" },
      ]),
      /target must contain non-whitespace content when matchMode is trim/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("trim replacement drops trailing whitespace-only edge lines", async () => {
    const original = "alpha\nbeta\n";
    const file = await tempFile("sample.txt", original);

    await applyTargetEdits(file, [
      { type: "replace", target: "alpha", matchMode: "trim", replacement: "  ALPHA\n   \n" },
    ]);

    assert.equal(await readFile(file, "utf8"), "ALPHA\nbeta\n");
  });
  it("insert_after with matchMode=trim", async () => {
    const original = "function foo() {\n    bar();\n}\n";
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "insert_after", target: "  bar();", line: 2, matchMode: "trim", lines: ["    baz();"] },
    ]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n    bar();\n    baz();\n}\n");
  });

  it("reports no tier note for an exact raw match", async () => {
    const file = await tempFile("sample.txt", "alpha\nbeta\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "alpha", line: 1, replacement: "ALPHA" },
    ]);

    assert.equal(await readFile(file, "utf8"), "ALPHA\nbeta\n");
    assert.doesNotMatch(result, /matched via/);
  });

  it("reports a trim tier note when indentation differs", async () => {
    const file = await tempFile("sample.ts", "function foo() {\n    bar();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "bar();", line: 2, matchMode: "trim", replacement: "baz();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n    baz();\n}\n");
    assert.match(result, /matched via trim \(indentation or trailing whitespace differed\)/);
  });

  it("reports an unescape tier note for escaped-newline fallback matches", async () => {
    const file = await tempFile("sample.ts", "before\nif (debug) {\n  log();\n}\nafter\n");
    const result = await applyTargetEdits(file, [
      { type: "delete", target: "if (debug) {\\n  log();\\n}\\n", line: 2 },
    ]);

    assert.equal(await readFile(file, "utf8"), "before\nafter\n");
    assert.match(result, /matched via unescape \(escape sequences in target were normalized\)/);
  });

  it("prefixes tier notes with op index for multi-op batches", async () => {
    const file = await tempFile("sample.ts", "function foo() {\n    bar();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "foo()", line: 1, replacement: "baz()" },
      { type: "replace", target: "bar();", line: 2, matchMode: "trim", replacement: "qux();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function baz() {\n    qux();\n}\n");
    assert.match(result, /op\[1\] matched via trim \(indentation or trailing whitespace differed\)/);
    assert.doesNotMatch(result, /op\[0\] matched/);
  });

  it("reports correct post-rebase diff headers for a multi-op batch", async () => {
    const file = await tempFile("sample.txt", "a\nb\nT\nc\nT\nd\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "T", line: 5, replacement: "X\nY" },
      { type: "replace", target: "T", line: 3, replacement: "P\nQ" },
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nb\nP\nQ\nc\nX\nY\nd\n");
    assert.match(result, /^:6-7$/m, `expected rebased header :6-7, got:\n${result}`);
    assert.match(result, /^:3-4$/m);
  });

  it("places the notes block before the diff and contexts", async () => {
    const file = await tempFile("sample.ts", "function foo() {\n    bar();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "bar();", line: 2, matchMode: "trim", replacement: "baz();" },
    ]);

    const noteIndex = result.indexOf("matched via trim");
    const diffIndex = result.indexOf("── diff ──");
    const contextIndex = result.indexOf("2|");
    assert.ok(noteIndex !== -1 && diffIndex !== -1 && contextIndex !== -1, result);
    assert.ok(noteIndex < diffIndex && diffIndex < contextIndex,
      `notes must precede diff and contexts (note=${noteIndex} diff=${diffIndex} ctx=${contextIndex})\n${result}`);
  });

  it("reports an occurrence count when a range replace changes multiple occurrences", async () => {
    const file = await tempFile("sample.txt", "a\nfoo\nb\nfoo\nc\nfoo\nd\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "foo", range: { startLine: 1, endLine: 7 }, replacement: "bar" },
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nbar\nb\nbar\nc\nbar\nd\n");
    assert.match(result, /^replaced 3 occurrences[\s\S]*── diff ──/);
    assert.ok(result.indexOf("replaced 3 occurrences") < result.indexOf("── diff ──"), result);
  });

  it("reports no occurrence-count note for a single-occurrence replace", async () => {
    const file = await tempFile("sample.txt", "a\nfoo\nb\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "foo", line: 2, replacement: "bar" },
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nbar\nb\n");
    assert.doesNotMatch(result, /occurrences/);
  });

  it("prefixes occurrence-count notes with op index in multi-op batches", async () => {
    const file = await tempFile("sample.txt", "a\nfoo\nb\nfoo\nc\nfoo\nd\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "foo", line: 2, replacement: "bar" },
      { type: "delete", target: "foo", range: { startLine: 1, endLine: 6 } },
    ]);

    assert.equal(await readFile(file, "utf8"), "a\nbar\nb\n\nc\n\nd\n");
    assert.match(result, /op\[1\] deleted 2 occurrences/);
    assert.doesNotMatch(result, /op\[0\] .*occurrences/);
  });

  it("keeps an exact hit authoritative over a trim occurrence elsewhere", async () => {
    // Regression: auto-cascade must only fall to trim when neither the raw
    // target nor its unescaped form matches. A unique exact match must not be
    // diluted by a trim occurrence on a different line, which would turn the
    // no-line/range path into an ambiguous reject.
    const file = await tempFile("sample.txt", "if (a) {\n  foo();\n}\nwhile (b) {\n\tfoo();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "  foo();", replacement: "  bar();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "if (a) {\n  bar();\n}\nwhile (b) {\n\tfoo();\n}\n");
    assert.doesNotMatch(result, /matched via/);
  });

  it("auto-trim replace does not double the replacement indentation", async () => {
    // Regression: auto-cascade can produce a trimmed occurrence with no explicit
    // matchMode. The replacement must still be edge-trimmed to avoid doubling
    // the file's original indentation.
    const file = await tempFile("sample.ts", "function a() {\n\tconst x = 1;\n}\n");
    await applyTargetEdits(file, [
      { type: "replace", target: "    const x = 1;", replacement: "    const x = 2;" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function a() {\n\tconst x = 2;\n}\n");
  });

  it("auto-trim replace matches explicit matchMode:trim output", async () => {
    // Invariant: the same trimmed occurrence must produce identical file content
    // whether it came from auto-cascade or explicit matchMode:"trim".
    const auto = await tempFile("sample.ts", "function a() {\n\tconst x = 1;\n}\n");
    const explicit = await tempFile("sample.ts", "function a() {\n\tconst x = 1;\n}\n");

    await applyTargetEdits(auto, [
      { type: "replace", target: "    const x = 1;", replacement: "    const x = 2;" },
    ]);
    await applyTargetEdits(explicit, [
      { type: "replace", target: "    const x = 1;", matchMode: "trim", replacement: "    const x = 2;" },
    ]);

    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
    assert.equal(await readFile(auto, "utf8"), "function a() {\n\tconst x = 2;\n}\n");
  });

  it("auto-trim multi-line block replace matches explicit matchMode:trim per line", async () => {
    // The trimmed occurrence is bounded to the file's trimmed content, so the
    // first line keeps the file's indentation while the replacement's internal
    // and last-line indentation is used as-is. Auto-trim must agree with explicit
    // matchMode:"trim" line-for-line.
    const setup = "function a() {\n\tif (x) {\n\t\tconst y = 1;\n\t\tlog(y);\n\t}\n}\n";
    const block = "  if (x) {\n    const y = 1;\n    log(y);\n  }";
    const replacement = "  if (x) {\n    const y = 2;\n    log(y);\n  }";
    const expected = "function a() {\n\tif (x) {\n    const y = 2;\n    log(y);\n  }\n}\n";

    const auto = await tempFile("sample.ts", setup);
    await applyTargetEdits(auto, [{ type: "replace", target: block, replacement }]);

    const explicit = await tempFile("sample.ts", setup);
    await applyTargetEdits(explicit, [{ type: "replace", target: block, matchMode: "trim", replacement }]);

    assert.equal(await readFile(auto, "utf8"), expected);
    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
  });

  it("auto-cascade trim-of-unescaped replace matches explicit matchMode:trim on escaped+indent-drifted target", async () => {
    // A target that both contains escape sequences (literal \t written as \\t)
    // and has indentation drift previously matched under explicit trim but was
    // rejected by the auto-cascade (which never tried trim-of-unescaped). Auto
    // output must be byte-identical to explicit trim output -- including the
    // uniform indent adjustment applied to the flat block.
    const setup = "function run() {\n\tlog(\"a\tb\");\n\tteardown();\n}\n";
    const target = "log(\"a\\tb\");\nteardown();";
    const replacement = "log(\"a\tb\");\ncleanup();";

    const auto = await tempFile("sample.ts", setup);
    const autoResult = await applyTargetEdits(auto, [{ type: "replace", target, replacement }]);

    const explicit = await tempFile("sample.ts", setup);
    await applyTargetEdits(explicit, [{ type: "replace", target, matchMode: "trim", replacement }]);

    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
    assert.equal(await readFile(auto, "utf8"), "function run() {\n\tlog(\"a\tb\");\n\tcleanup();\n}\n");
    assert.match(autoResult, /matched via unescape\+trim/);
  });

  it("trim-of-unescaped replace preserves indentation and trims replacement edges", async () => {
    // Regression for the kind-labeling bug: trim-of-unescaped occurrences were
    // labeled "fallback", so replaceRanges skipped edge-trimming and doubled the
    // file's indentation. They must behave as trimmed, and the uniform indent
    // adjustment re-indents the dedented flat-block replacement lines 2+.
    const file = await tempFile("sample.ts", "function run() {\n\tlog(\"a\tb\");\n\tteardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "log(\"a\\tb\");\nteardown();", matchMode: "trim", replacement: "log(\"a\tb\");\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n\tlog(\"a\tb\");\n\tcleanup();\n}\n");
    assert.match(result, /matched via unescape\+trim/);
  });

  it("trim-of-unescaped delete removes whole lines including the terminator", async () => {
    const file = await tempFile("sample.ts", "function a() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n");
    await applyTargetEdits(file, [
      { type: "delete", target: "if (x) {\n\\treturn 1;\n}", matchMode: "trim" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function a() {\n}\n");
  });

  it("uniform indent adjustment adds the file's indent to a dedented multi-line replacement", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n    teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "setup();\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    init();\n    cleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("uniform indent adjustment removes an over-indented prefix from a multi-line replacement", async () => {
    const file = await tempFile("sample.ts", "function run() {\nsetup();\nteardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "    setup();\n    teardown();", matchMode: "trim", replacement: "    init();\n    cleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\ninit();\ncleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("uniform indent adjustment handles a tab-based delta", async () => {
    const file = await tempFile("sample.ts", "function run() {\n\tsetup();\n\tteardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "setup();\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n\tinit();\n\tcleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("non-uniform indentation drift across target lines disables the indent adjustment", async () => {
    // The drift is 4 spaces on line 1 but 8 on line 2, so no uniform adjustment
    // applies: line 1 lands at the file's indent while line 2+ stay literal.
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n        teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "setup();\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    init();\ncleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("remove shift falls back to literal when a replacement line lacks the prefix", async () => {
    // Replacement line 2 is indented 2 spaces, not the 4 to remove, so the
    // whole adjustment is abandoned (all-or-nothing) and lines insert literally.
    const file = await tempFile("sample.ts", "function run() {\nsetup();\nteardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "    setup();\n    teardown();", matchMode: "trim", replacement: "    init();\n  cleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\ninit();\n  cleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("trimmed-unescaped occurrence also gets the uniform indent adjustment", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    log(\"a\tb\");\n    teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "log(\"a\\tb\");\nteardown();", matchMode: "trim", replacement: "log(\"a\tb\");\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    log(\"a\tb\");\n    cleanup();\n}\n");
    assert.match(result, /matched via unescape\+trim/);
  });

  it("auto-cascade and explicit trim stay byte-identical with the indent adjustment applied", async () => {
    const setup = "function run() {\n    setup();\n    teardown();\n}\n";
    const target = "setup();\nteardown();";
    const replacement = "init();\ncleanup();";

    const auto = await tempFile("sample.ts", setup);
    await applyTargetEdits(auto, [{ type: "replace", target, replacement }]);

    const explicit = await tempFile("sample.ts", setup);
    await applyTargetEdits(explicit, [{ type: "replace", target, matchMode: "trim", replacement }]);

    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
    assert.equal(await readFile(auto, "utf8"), "function run() {\n    init();\n    cleanup();\n}\n");
  });

  it("indent adjustment preserves CRLF line endings", async () => {
    const file = await tempFile("sample.ts", "function run() {\r\n\tsetup();\r\n\tteardown();\r\n}\r\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "setup();\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\r\n\tinit();\r\n\tcleanup();\r\n}\r\n");
    assert.match(result, /matched via trim/);
  });

  it("range mode applies each trim occurrence's own indent delta", async () => {
    const file = await tempFile("sample.ts", "function a() {\n    foo();\n    bar();\n}\nfunction b() {\n\tfoo();\n\tbar();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "foo();\nbar();", matchMode: "trim", replacement: "foo();\nbaz();", range: { startLine: 1, endLine: 8 } },
    ]);

    assert.equal(await readFile(file, "utf8"), "function a() {\n    foo();\n    baz();\n}\nfunction b() {\n\tfoo();\n\tbaz();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("trim target with a leading blank line matches with indent drift", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n    teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "\nsetup();", matchMode: "trim", replacement: "init();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    init();\n    teardown();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("trim target with both leading and trailing blank lines matches", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n    teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "\nsetup();\nteardown();\n", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    init();\n    cleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("auto-cascade and explicit trim stay byte-identical for a leading-blank-line target", async () => {
    const setup = "function run() {\n    setup();\n    teardown();\n}\n";
    const target = "\nsetup();\nteardown();";
    const replacement = "init();\ncleanup();";

    const auto = await tempFile("sample.ts", setup);
    await applyTargetEdits(auto, [{ type: "replace", target, replacement }]);

    const explicit = await tempFile("sample.ts", setup);
    await applyTargetEdits(explicit, [{ type: "replace", target, matchMode: "trim", replacement }]);

    assert.equal(await readFile(auto, "utf8"), await readFile(explicit, "utf8"));
    assert.equal(await readFile(auto, "utf8"), "function run() {\n    init();\n    cleanup();\n}\n");
  });

  it("a blank line strictly inside the trim target still requires a blank line in the file", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n    teardown();\n}\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "setup();\n\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
      ]),
      /target not found/,
    );
    assert.equal(await readFile(file, "utf8"), "function run() {\n    setup();\n    teardown();\n}\n");
  });

  it("a whitespace-only trim target still rejects", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n}\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "\n  \n", matchMode: "trim", replacement: "x();" },
      ]),
      /must contain non-whitespace content when matchMode is trim/,
    );
    assert.equal(await readFile(file, "utf8"), "function run() {\n    setup();\n}\n");
  });

  it("leading-blank-line trim target combines with the uniform indent adjustment", async () => {
    const file = await tempFile("sample.ts", "function run() {\n    setup();\n    teardown();\n}\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "\nsetup();\nteardown();", matchMode: "trim", replacement: "init();\ncleanup();" },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n    init();\n    cleanup();\n}\n");
    assert.match(result, /matched via trim/);
  });

  it("unescaped-substring hit still wins and trim-of-unescaped does not run", async () => {
    // When the unescaped substring tier hits, the auto-cascade must not fall
    // through to trim-of-unescaped. Result uses literal substring semantics (the
    // leading tab is consumed) and reports the unescape tier, not unescape+trim.
    const file = await tempFile("sample.txt", "alpha\n\tfoo;\nbeta\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "\\tfoo;", replacement: "bar;" },
    ]);

    assert.equal(await readFile(file, "utf8"), "alpha\nbar;\nbeta\n");
    assert.match(result, /matched via unescape \(escape sequences in target were normalized\)/);
    assert.doesNotMatch(result, /unescape\+trim/);
  });

  it("rejects ambiguous trim-of-unescaped with no line or range", async () => {
    const file = await tempFile("sample.txt", "a\n \t foo;\nb\n  \t  foo;\nc\n");
    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "\\tfoo;", replacement: "bar;" },
      ]),
      /occurs 2 times in the file.*provide line or range/
    );
  });

});

describe("structured failures", () => {
  it("embeds parseable snap-edit-error JSON on expectedStartLine mismatch", async () => {
    const file = await tempFile("sample.txt", "one\ninserted\ntwo\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 2, expectedStartLine: "two", lines: ["TWO"] }]),
      (error: unknown) => {
        assert.ok(error instanceof SnapEditError);
        assert.match(error.message, new RegExp(SNAP_EDIT_ERROR_MARKER));
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_START_LINE_MISMATCH");
        assert.equal(failure.edit_index, 0);
        assert.equal(failure.at_line, 2);
        assert.equal(failure.actual, "inserted");
        assert.equal(failure.expected, "two");
        assert.deepEqual(failure.candidates, [{ line: 3, text: "two" }]);
        assert.deepEqual(failure.suggested, { start: 3, expectedStartLine: "two" });
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "one\ninserted\ntwo\n");
  });

  it("suggests indent_tolerant when exact guard fails but trim matches", async () => {
    const file = await tempFile("sample.txt", "  value = false\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, expectedStartLine: "value = false", lines: ["value = true"] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_START_LINE_MISMATCH");
        assert.deepEqual(failure.suggested, { whitespace: "indent_tolerant" });
        assert.equal(failure.at_line, 1);
        return true;
      },
    );
  });

  it("structures overlapping range failures", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyQuickEdits(file, [editFor(original, 1, 3, ["x"]), editFor(original, 3, 4, ["y"])]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "OVERLAPPING_RANGES");
        assert.deepEqual(failure.details, {
          ranges: [
            { start: 1, end: 3 },
            { start: 3, end: 4 },
          ],
        });
        return true;
      },
    );
  });

  it("structures target_edit not-found failures with candidates", async () => {
    const file = await tempFile("sample.txt", "const enabled = false;\n");

    await assert.rejects(
      () => applyTargetEdits(file, [{ type: "replace", target: "const enabled = fasle;", replacement: "const enabled = true;" }]),
      (error: unknown) => {
        assert.ok(error instanceof SnapEditError);
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "TARGET_NOT_FOUND");
        assert.equal(failure.op_index, 0);
        assert.equal(failure.expected, "const enabled = fasle;");
        assert.ok(failure.candidates && failure.candidates.length >= 1);
        assert.equal(failure.candidates[0]!.line, 1);
        assert.match(failure.candidates[0]!.text, /const enabled = false;/);
        return true;
      },
    );
  });

  it("structures ambiguous unique-target failures", async () => {
    const file = await tempFile("sample.txt", "dup\ndup\n");

    await assert.rejects(
      () => applyTargetEdits(file, [{ type: "replace", target: "dup", replacement: "DUP" }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "TARGET_AMBIGUOUS");
        assert.equal(failure.details?.found, 2);
        assert.ok(failure.candidates && failure.candidates.length === 2);
        assert.deepEqual(failure.suggested, { line: 1 });
        return true;
      },
    );
  });

  it("parseSnapEditError reads marker from plain error messages", () => {
    const message = `edit[0] boom\n${SNAP_EDIT_ERROR_MARKER}\n${JSON.stringify({
      error_code: "VALIDATION",
      message: "edit[0] boom",
    })}`;
    assert.deepEqual(parseSnapEditError(message), {
      error_code: "VALIDATION",
      message: "edit[0] boom",
    });
  });
});

describe("quick_edit schema", () => {
  it("exposes EOF append as a distinct edit shape without range guards", () => {
    const items = QuickEditParams.properties.edits.items as unknown as {
      anyOf: Array<{ properties: { start: { const?: unknown }; lines: { minItems?: number } }; required?: string[] }>;
    };
    assert.equal(items.anyOf.length, 2);

    const eofShape = items.anyOf.find((shape) => shape.properties.start.const === "eof");
    assert.ok(eofShape);
    assert.deepEqual(Object.keys(eofShape.properties), ["start", "lines"]);
    assert.deepEqual(eofShape.required, ["start", "lines"]);
    assert.equal(eofShape.properties.lines.minItems, 1);
  });
});

describe("quick_edit eof and range guards", () => {
  it("appends with start=\"eof\" without expectedStartLine", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\n");
    await applyQuickEdits(file, [{ start: "eof", lines: ["three"] }]);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("appends with start=\"eof\" on empty file", async () => {
    const file = await tempFile("sample.txt", "");
    await applyQuickEdits(file, [{ start: "eof", lines: ["first"] }]);
    assert.equal(await readFile(file, "utf8"), "first");
  });

  it("rejects start=\"eof\" with end set", async () => {
    const file = await tempFile("sample.txt", "one\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{ start: "eof", end: 1, lines: ["x"] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "INVALID_RANGE");
        return true;
      },
    );
  });

  it("rejects start=\"eof\" with empty lines", async () => {
    const file = await tempFile("sample.txt", "one\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{ start: "eof", lines: [] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "VALIDATION");
        return true;
      },
    );
  });

  it("keeps legacy start=lineCount+1 EOF insert", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\n");
    await applyQuickEdits(file, [{ start: 3, expectedStartLine: "", lines: ["three"] }]);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("accepts whitespace=indent_tolerant as trim+preserveIndent", async () => {
    const file = await tempFile("sample.txt", "function run() {\n\tif (enabled) {\n\t\toldCall();\n\t}\n}\n");

    await applyQuickEdits(file, [
      {
        start: 2,
        end: 4,
        expectedStartLine: "if (enabled) {",
        whitespace: "indent_tolerant",
        lines: ["if (ready) {", "  newCall();", "}"],
      },
    ]);

    assert.equal(await readFile(file, "utf8"), "function run() {\n\tif (ready) {\n\t  newCall();\n\t}\n}\n");
  });

  it("lets explicit expectedStartLineMatch override whitespace shortcut", async () => {
    const file = await tempFile("sample.txt", "  value = false\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{
        start: 1,
        expectedStartLine: "value = false",
        whitespace: "indent_tolerant",
        expectedStartLineMatch: "exact",
        lines: ["value = true"],
      }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_START_LINE_MISMATCH");
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "  value = false\n");
  });

  it("accepts expectedEndLine and expectedLineCount guards", async () => {
    const file = await tempFile("sample.txt", "function foo() {\n  return 1;\n}\nconst x = 1;\n");

    await applyQuickEdits(file, [{
      start: 1,
      end: 3,
      expectedStartLine: "function foo() {",
      expectedEndLine: "}",
      expectedLineCount: 3,
      lines: ["function foo() {", "  return 2;", "}"],
    }]);

    assert.equal(await readFile(file, "utf8"), "function foo() {\n  return 2;\n}\nconst x = 1;\n");
  });

  it("rejects expectedEndLine mismatch with structured failure", async () => {
    const file = await tempFile("sample.txt", "function foo() {\n  return 1;\n}\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{
        start: 1,
        end: 3,
        expectedStartLine: "function foo() {",
        expectedEndLine: "};",
        lines: ["function foo() {", "  return 2;", "}"],
      }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_END_LINE_MISMATCH");
        assert.equal(failure.end_line, 3);
        assert.equal(failure.actual, "}");
        assert.equal(failure.expected, "};");
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "function foo() {\n  return 1;\n}\n");
  });

  it("rejects expectedLineCount mismatch with structured failure", async () => {
    const file = await tempFile("sample.txt", "a\nb\nc\n");

    await assert.rejects(
      () => applyQuickEdits(file, [{
        start: 1,
        end: 2,
        expectedStartLine: "a",
        expectedLineCount: 3,
        lines: ["A", "B"],
      }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "EXPECTED_LINE_COUNT_MISMATCH");
        assert.deepEqual(failure.details, {
          expected_line_count: 3,
          actual_line_count: 2,
        });
        assert.deepEqual(failure.suggested, { expectedLineCount: 2 });
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "a\nb\nc\n");
  });

  it("requires expectedStartLine for non-eof line edits", async () => {
    const file = await tempFile("sample.txt", "one\n");
    await assert.rejects(
      () => applyQuickEdits(file, [{ start: 1, lines: ["ONE"] }]),
      (error: unknown) => {
        const failure = parseSnapEditError(error);
        assert.ok(failure);
        assert.equal(failure.error_code, "VALIDATION");
        assert.deepEqual(failure.suggested, { expectedStartLine: "one" });
        return true;
      },
    );
  });
});
