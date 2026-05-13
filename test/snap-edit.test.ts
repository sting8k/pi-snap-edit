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
});


describe("quick-edit renderer helpers", () => {
  it("summarizes compact quick-edit diffs", () => {
    const text = "── diff ──\n:2\n- old\n+ new\n\n1| alpha";
    assert.deepEqual(summarizeQuickEditOutput(text), { additions: 1, removals: 1, hasDiff: true });
  });

  it("handles context-only quick-edit output", () => {
    assert.deepEqual(summarizeQuickEditOutput("1| alpha"), { additions: 0, removals: 0, hasDiff: false });
  });
  it("prefers quick_edit by removing built-in edit from active tools", () => {
    assert.deepEqual(preferQuickEditTools(["read", "edit", "bash"]), ["read", "bash", "quick_edit", "substitute_edit", "target_edit"]);
    assert.deepEqual(preferQuickEditTools(["read", "quick_edit", "edit"]), ["read", "quick_edit", "substitute_edit", "target_edit"]);
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
});

describe("target edits", () => {
  it("replaces exact target text by occurrence and returns numbered context", async () => {
    const file = await tempFile("sample.ts", "const app = createApp();\napp.mount('#app');\n");
    const result = await applyTargetEdits(file, [
      { type: "replace", target: "app.mount('#app')", occurrence: 1, replacement: "app.mount('#root')" },
    ]);

    assert.equal(await readFile(file, "utf8"), "const app = createApp();\napp.mount('#root');\n");
    assert.match(result, /── diff ──/);
    assert.match(result, /- app\.mount\('#app'\);/);
    assert.match(result, /\+ app\.mount\('#root'\);/);
    assert.match(result, /1\| const app = createApp\(\);\n2\| app\.mount\('#root'\);/);
  });

  it("inserts full lines before or after the line containing the target", async () => {
    const file = await tempFile("sample.ts", "const app = createApp();\napp.mount('#app');\n");
    await applyTargetEdits(file, [
      { type: "insert", target: "const app = createApp();", occurrence: 1, position: "after", lines: ["app.use(logger);"] },
    ]);

    assert.equal(await readFile(file, "utf8"), "const app = createApp();\napp.use(logger);\napp.mount('#app');\n");
  });

  it("deletes multi-line target text", async () => {
    const original = [
      "before",
      "if (debug) {",
      "  console.log(value);",
      "}",
      "after",
    ].join("\n");
    const file = await tempFile("sample.ts", original);

    await applyTargetEdits(file, [
      { type: "delete", target: "if (debug) {\n  console.log(value);\n}\n", occurrence: 1 },
    ]);

    assert.equal(await readFile(file, "utf8"), "before\nafter");
  });

  it("uses scope and count to edit repeated targets safely", async () => {
    const file = await tempFile("sample.ts", "one();\ntarget();\ntwo();\ntarget();\n");
    await applyTargetEdits(
      file,
      [{ type: "replace", target: "target()", count: 1, replacement: "selected()" }],
      { startLine: 3, endLine: 4 },
    );

    assert.equal(await readFile(file, "utf8"), "one();\ntarget();\ntwo();\nselected();\n");
  });

  it("rejects selector/count failures atomically", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const file = await tempFile("sample.txt", original);

    await assert.rejects(
      async () => applyTargetEdits(file, [
        { type: "replace", target: "alpha", occurrence: 1, replacement: "ALPHA" },
        { type: "replace", target: "missing", occurrence: 1, replacement: "MISSING" },
      ]),
      /op\[1\] expected occurrence 1/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("preserves CRLF and no-trailing-newline files", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree");
    await applyTargetEdits(file, [
      { type: "insert", target: "two", occurrence: 1, position: "after", lines: ["TWO-AND-A-HALF"] },
      { type: "replace", target: "three", occurrence: 1, replacement: "THREE" },
    ]);

    assert.equal(await readFile(file, "utf8"), "one\r\ntwo\r\nTWO-AND-A-HALF\r\nTHREE");
  });
  it("reports earlier changes at final line positions after later line-shifting ops", async () => {
    const original = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);

    const result = await applyTargetEdits(file, [
      { type: "replace", target: "line10", occurrence: 1, replacement: "LINE10" },
      {
        type: "insert",
        target: "line1",
        occurrence: 1,
        position: "before",
        lines: Array.from({ length: 10 }, (_, index) => `inserted-${index + 1}`),
      },
    ]);

    assert.equal(
      await readFile(file, "utf8"),
      [...Array.from({ length: 10 }, (_, index) => `inserted-${index + 1}`), ...original.slice(0, 9), "LINE10", ...original.slice(10)].join("\n") + "\n",
    );
    assert.match(result, /:20\n- line10\n\+ LINE10/);
    assert.match(result, /20\| LINE10/);
  });

});
