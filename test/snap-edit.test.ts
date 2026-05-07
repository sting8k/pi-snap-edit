import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import snapEditExtension, {
  applyQuickEdits,
  applyStructuredEdits,
  formatHash,
  hashLines,
  invalidAnchorMessage,
  hashReadText,
  lineHash,
  parseAnchor,
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
    startLine,
    startHash: lineHash(lines[startLine - 1] ?? ""),
    endLine,
    endHash: lineHash(lines[endLine - 1] ?? ""),
    lines: replacementLines,
  };
}

function anchorFor(lines: string[], line: number): string {
  return `${line}:${formatHash(lineHash(lines[line - 1] ?? ""))}`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("hash helpers", () => {
  it("formats deterministic 12-bit FNV hashes", () => {
    assert.equal(formatHash(lineHash("")), "dc5");
    assert.equal(formatHash(lineHash("alpha")), "dab");
    assert.equal(formatHash(lineHash("こんにちは")), "ccd");
  });

  it("hashes lines with caller-provided starting line", () => {
    assert.equal(hashLines(["alpha", "", "beta"], 41), "41:dab|alpha\n42:dc5|\n43:4c7|beta");
  });

  it("parses valid anchors and rejects malformed anchors", () => {
    assert.deepEqual(parseAnchor("42:0af"), { line: 42, hash: 0x0af });
    assert.deepEqual(parseAnchor(" 42 : 0AF "), { line: 42, hash: 0x0af });
    assert.equal(parseAnchor("0:abc"), undefined);
    assert.equal(parseAnchor("42"), undefined);
    assert.equal(parseAnchor("42:abc:extra"), undefined);
    assert.equal(parseAnchor("x:abc"), undefined);
    assert.equal(parseAnchor("42:xyz"), undefined);
    assert.equal(parseAnchor("42:abc|const value = 1;"), undefined);
    assert.equal(
      invalidAnchorMessage("42:abc|const value = 1;"),
      "invalid anchor '42:abc|const value = 1;'. Use only '42:abc' before '|'.",
    );
    assert.equal(invalidAnchorMessage("42"), "invalid anchor '42'. Expected '<line>:<hash>', e.g. '11:f80'.");
  });

  it("splits text while preserving editable lines semantics", () => {
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("one\n"), ["one"]);
    assert.deepEqual(splitLines("one\ntwo"), ["one", "two"]);
    assert.deepEqual(splitLines("one\r\ntwo\r\n"), ["one", "two"]);
  });
});

describe("read result hashing hook", () => {
  it("adds anchors to plain core read text", () => {
    assert.equal(hashReadText("alpha\nbeta", undefined), "1:dab|alpha\n2:4c7|beta");
  });

  it("starts anchors at read offset", () => {
    assert.equal(hashReadText("alpha\nbeta", 10), "10:dab|alpha\n11:4c7|beta");
  });

  it("preserves core read continuation notices", () => {
    const text = "alpha\nbeta\n\n[Showing lines 5-6 of 20. Use offset=7 to continue.]";
    assert.equal(hashReadText(text, 5), "5:dab|alpha\n6:4c7|beta\n\n[Showing lines 5-6 of 20. Use offset=7 to continue.]");
  });

  it("preserves byte-limit continuation notices", () => {
    const text = "alpha\n\n[Showing lines 1-1 of 20 (50KB limit). Use offset=2 to continue.]";
    assert.equal(hashReadText(text, 1), "1:dab|alpha\n\n[Showing lines 1-1 of 20 (50KB limit). Use offset=2 to continue.]");
  });

  it("preserves user-limit continuation notices", () => {
    const text = "alpha\n\n[3 more lines in file. Use offset=2 to continue.]";
    assert.equal(hashReadText(text, undefined), "1:dab|alpha\n\n[3 more lines in file. Use offset=2 to continue.]");
  });

  it("does not alter image or oversized-line read notes", () => {
    assert.equal(hashReadText("Read image file [image/png]", undefined), "Read image file [image/png]");
    assert.equal(hashReadText("[Line 7 is 80KB, exceeds 50KB limit. Use bash: sed -n '7p' file | head -c 51200]", undefined), "[Line 7 is 80KB, exceeds 50KB limit. Use bash: sed -n '7p' file | head -c 51200]");
  });

  it("normalizes CRLF emitted by core read text before hashing", () => {
    assert.equal(hashReadText("alpha\r\nbeta", undefined), "1:dab|alpha\n2:4c7|beta");
  });
});

describe("quick-edit renderer helpers", () => {
  it("summarizes compact quick-edit diffs", () => {
    const text = "── diff ──\n:2\n- 2:4c7|old\n+ 2:aeb|new\n\n1:dab|alpha";
    assert.deepEqual(summarizeQuickEditOutput(text), { additions: 1, removals: 1, hasDiff: true });
  });

  it("handles context-only quick-edit output", () => {
    assert.deepEqual(summarizeQuickEditOutput("1:dab|alpha"), { additions: 0, removals: 0, hasDiff: false });
  });
  it("prefers quick_edit by removing built-in edit from active tools", () => {
    assert.deepEqual(preferQuickEditTools(["read", "edit", "bash"]), ["read", "bash", "quick_edit", "structured_edit"]);
    assert.deepEqual(preferQuickEditTools(["read", "quick_edit", "edit"]), ["read", "quick_edit", "structured_edit"]);
  });
});

describe("quick edits", () => {
  it("applies single-line replacement and preserves trailing LF", async () => {
    const file = await tempFile("sample.ts", "one\ntwo\nthree\n");
    const result = await applyQuickEdits(file, [editFor(["one", "two", "three"], 2, 2, ["TWO"])]);

    assert.equal(await readFile(file, "utf8"), "one\nTWO\nthree\n");
    assert.match(result, /── diff ──/);
    assert.match(result, /- 2:.+\|two/);
    assert.match(result, /\+ 2:.+\|TWO/);
  });

  it("applies multi-line replacements in reverse order without shifting later anchors", async () => {
    const original = ["a", "b", "c", "d", "e"];
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);
    await applyQuickEdits(
      file,
      [editFor(original, 2, 3, ["B", "C", "CC"]), editFor(original, 5, 5, ["E"])],
    );

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

  it("handles unicode content hashes and replacements", async () => {
    const original = ["hello", "こんにちは", "bye"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 2, ["こんばんは"])]);

    assert.equal(await readFile(file, "utf8"), "hello\nこんばんは\nbye");
  });

  it("rejects stale start hashes atomically", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const stale = editFor(["one", "OLD", "three"], 2, 2, ["TWO"]);

    await assert.rejects(() => applyQuickEdits(file, [stale]), /hash mismatch/);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("rejects stale end hashes atomically", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const edit = editFor(["one", "two", "OLD"], 2, 3, ["TWO"]);

    await assert.rejects(() => applyQuickEdits(file, [edit]), /hash mismatch/);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("rejects overlapping ranges atomically", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyQuickEdits(file, [editFor(original, 1, 3, ["x"]), editFor(original, 3, 4, ["y"])]),
      /overlapping edit ranges/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects out-of-bounds and reversed ranges atomically", async () => {
    const original = ["a", "b"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyQuickEdits(file, [{ startLine: 3, startHash: 0, endLine: 3, endHash: 0, lines: ["x"] }]),
      /out of bounds/,
    );
    await assert.rejects(
      () => applyQuickEdits(file, [{ startLine: 2, startHash: lineHash("b"), endLine: 1, endHash: lineHash("a"), lines: ["x"] }]),
      /end < start/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });
});

describe("structured edits", () => {
  it("applies counted substitutions inside an anchored scope only", async () => {
    const original = [
      "function build() {",
      "  logger.debug(\"a\");",
      "  logger.debug(\"b\");",
      "}",
      "logger.debug(\"outside\");",
    ];
    const file = await tempFile("sample.ts", `${original.join("\n")}\n`);

    const result = await applyStructuredEdits(
      file,
      [{ type: "substitute", old: "logger.debug", new: "logger.trace", count: 2 }],
      { start: anchorFor(original, 1), end: anchorFor(original, 4) },
    );

    assert.match(result, /logger\.trace/);
    assert.equal(
      await readFile(file, "utf8"),
      'function build() {\n  logger.trace("a");\n  logger.trace("b");\n}\nlogger.debug("outside");\n',
    );
  });

  it("rejects substitute count mismatches atomically", async () => {
    const original = ["alpha", "beta", "gamma"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyStructuredEdits(file, [{ type: "substitute", old: "beta", new: "BETA", count: 2 }]),
      /op\[0\] substitute: substitute expected 2 occurrence/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("applies anchored insert, replace, and delete operations in order", async () => {
    const original = ["start", "middle", "remove", "end"];
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);

    const result = await applyStructuredEdits(file, [
      { type: "insert_after", anchor: anchorFor(original, 1), lines: ["inserted"] },
      { type: "replace_lines", start: anchorFor(original, 2), lines: ["MIDDLE", "middle-extra"] },
      { type: "delete_lines", start: anchorFor(original, 3) },
    ]);

    assert.equal(await readFile(file, "utf8"), "start\ninserted\nMIDDLE\nmiddle-extra\nend\n");
    assert.doesNotMatch(result, /\n---\n/);
  });

  it("appends after the last anchored line with insert_after", async () => {
    const original = ["one", "two"];
    const file = await tempFile("sample.txt", original.join("\n"));

    const result = await applyStructuredEdits(file, [{ type: "insert_after", anchor: anchorFor(original, 2), lines: ["three", "four"] }]);

    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\nfour");
    assert.doesNotMatch(result, /- 2:.*\|two/);
    assert.match(result, /\+ 3:.*\|three/);
    assert.match(result, /\+ 4:.*\|four/);
  });

  it("can substitute the current whole file after an earlier line operation", async () => {
    const original = ["start", "middle", "end"];
    const file = await tempFile("sample.txt", `${original.join("\n")}\n`);

    await applyStructuredEdits(file, [
      { type: "insert_after", anchor: anchorFor(original, 1), lines: ["middle"] },
      { type: "substitute", old: "middle", new: "MIDDLE", count: 2 },
    ]);

    assert.equal(await readFile(file, "utf8"), "start\nMIDDLE\nMIDDLE\nend\n");
  });

  it("rejects stale scope anchors atomically", async () => {
    const original = ["start", "body", "end"];
    const file = await tempFile("sample.txt", original.join("\n"));
    const staleScopeLines = ["start", "OLD", "end"];

    await assert.rejects(
      () => applyStructuredEdits(
        file,
        [{ type: "substitute", old: "body", new: "BODY" }],
        { start: anchorFor(staleScopeLines, 2), end: anchorFor(original, 3) },
      ),
      /hash mismatch at scope start line 2/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects stale operation anchors atomically", async () => {
    const original = ["one", "two", "three"];
    const file = await tempFile("sample.txt", original.join("\n"));
    const staleLines = ["one", "OLD", "three"];

    await assert.rejects(
      () => applyStructuredEdits(file, [{ type: "replace_lines", start: anchorFor(staleLines, 2), lines: ["TWO"] }]),
      /op\[0\] replace_lines: hash mismatch at replace_lines start line 2/,
    );
    await assert.rejects(
      () => applyStructuredEdits(file, [{ type: "insert_after", anchor: `${anchorFor(original, 2)}|two`, lines: ["x"] }]),
      /Use only '2:.+' before '\|'\./,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects reversed and out-of-bounds line ranges atomically", async () => {
    const original = ["one", "two"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyStructuredEdits(file, [{ type: "replace_lines", start: anchorFor(original, 2), end: anchorFor(original, 1), lines: ["x"] }]),
      /end < start/,
    );
    await assert.rejects(
      () => applyStructuredEdits(file, [{ type: "delete_lines", start: "3:dc5" }]),
      /out of bounds/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rolls back earlier in-memory changes when a later operation fails", async () => {
    const original = ["alpha", "beta"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyStructuredEdits(file, [
        { type: "substitute", old: "alpha", new: "ALPHA" },
        { type: "substitute", old: "missing", new: "MISSING" },
      ]),
      /op\[1\] substitute: substitute expected 1 occurrence/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects invalid substitute operations before writing", async () => {
    const original = ["alpha"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(() => applyStructuredEdits(file, [{ type: "substitute", old: "", new: "x" }]), /old must not be empty/);
    await assert.rejects(() => applyStructuredEdits(file, [{ type: "substitute", old: "alpha", new: "alpha" }]), /must differ/);
    await assert.rejects(() => applyStructuredEdits(file, [{ type: "substitute", old: "alpha", new: "a\nb" }]), /replace_lines/);
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("returns concise syntax guidance for malformed structured_edit arguments", async () => {
    const registered: any[] = [];
    snapEditExtension({
      on() {},
      registerTool(tool: any) {
        registered.push(tool);
      },
      setActiveTools() {},
      getActiveTools() {
        return [];
      },
    } as any);
    const tool = registered.find((entry) => entry.name === "structured_edit");
    assert.ok(tool);

    const executePrepared = (input: Record<string, unknown>) => {
      const prepared = tool.prepareArguments(input);
      return tool.execute("call-1", prepared, undefined, undefined, { cwd: process.cwd() });
    };

    await assert.rejects(
      () => executePrepared({
        path: "style.css",
        scope: '\n<parameter name="start">70:8b1',
        end: "73:8a8",
        ops: [{ type: "substitute", old: "a", new: "b", count: 1 }],
      }),
      /Invalid structured_edit scope\. Correct syntax: "scope":\{"start":"70:8b1","end":"73:8a8"\}\. Keep start\/end inside scope\./,
    );
    await assert.rejects(
      () => executePrepared({ path: "style.css", type: "replace_lines", start: "1:aaa", lines: ["x"] }),
      /Invalid structured_edit arguments\. Use "ops":\[/,
    );
    await assert.rejects(
      () => executePrepared({ path: "style.css", ops: [{ type: "replace_range", start: "1:aaa", end: "2:bbb", lines: ["x"] }] }),
      /Invalid structured_edit ops\[0\]\. Allowed types: substitute, replace_lines, delete_lines, insert_before, insert_after\. For range replacement use: \{"type":"replace_lines"/,
    );
    await assert.rejects(
      () => executePrepared({ path: "style.css", ops: [{ type: "replace_lines", start: "1:aaa" }] }),
      /Invalid structured_edit ops\[0\] replace_lines\. Correct syntax: \{"type":"replace_lines","start":"70:8b1","end":"73:8a8","lines":\["\.\.\."\]\}/,
    );
    await assert.rejects(
      () => executePrepared({ path: "style.css", ops: [{ type: "insert_after", start: "1:aaa", lines: ["x"] }] }),
      /Invalid structured_edit ops\[0\] insert_after\. Correct syntax: \{"type":"insert_after","anchor":"70:8b1","lines":\["\.\.\."\]\}/,
    );
  });

  it("replaces multiple occurrences on one line when count matches", async () => {
    const file = await tempFile("sample.txt", "foo foo\nbar");

    await applyStructuredEdits(file, [{ type: "substitute", old: "foo", new: "baz", count: 2 }]);

    assert.equal(await readFile(file, "utf8"), "baz baz\nbar");
  });

  it("preserves CRLF for structured line operations", async () => {
    const original = ["one", "two", "three"];
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree");

    await applyStructuredEdits(file, [{ type: "insert_after", anchor: anchorFor(original, 2), lines: ["inserted"] }]);

    assert.equal(await readFile(file, "utf8"), "one\r\ntwo\r\ninserted\r\nthree");
  });

  it("preserves CRLF and absence of trailing newline", async () => {
    const file = await tempFile("sample.txt", "one\r\ntwo\r\nthree");
    await applyStructuredEdits(file, [{ type: "substitute", old: "two", new: "TWO" }]);

    assert.equal(await readFile(file, "utf8"), "one\r\nTWO\r\nthree");
  });
});
