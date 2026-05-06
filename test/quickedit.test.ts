import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyQuickEdits,
  formatHash,
  hashLines,
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
  const dir = await mkdtemp(path.join(tmpdir(), "pi-quickedit-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

function editFor(lines: string[], startLine: number, endLine: number, content: string): Edit {
  return {
    startLine,
    startHash: lineHash(lines[startLine - 1] ?? ""),
    endLine,
    endHash: lineHash(lines[endLine - 1] ?? ""),
    content,
  };
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
    assert.deepEqual(preferQuickEditTools(["read", "edit", "bash"]), ["read", "bash", "quick_edit"]);
    assert.deepEqual(preferQuickEditTools(["read", "quick_edit", "edit"]), ["read", "quick_edit"]);
  });
});

describe("quick edits", () => {
  it("applies single-line replacement and preserves trailing LF", async () => {
    const file = await tempFile("sample.ts", "one\ntwo\nthree\n");
    const result = await applyQuickEdits(file, [editFor(["one", "two", "three"], 2, 2, "TWO")], true);

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
      [editFor(original, 2, 3, "B\nC\nCC"), editFor(original, 5, 5, "E")],
      false,
    );

    assert.equal(await readFile(file, "utf8"), "a\nB\nC\nCC\nd\nE\n");
  });

  it("deletes a line or range when content is empty", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 3, "")], false);

    assert.equal(await readFile(file, "utf8"), "a\nd");
  });

  it("preserves CRLF and absence of trailing newline", async () => {
    const original = ["first", "second", "third"];
    const file = await tempFile("sample.txt", "first\r\nsecond\r\nthird");
    await applyQuickEdits(file, [editFor(original, 2, 2, "SECOND\ninserted")], false);

    assert.equal(await readFile(file, "utf8"), "first\r\nSECOND\r\ninserted\r\nthird");
  });

  it("handles unicode content hashes and replacements", async () => {
    const original = ["hello", "こんにちは", "bye"];
    const file = await tempFile("sample.txt", original.join("\n"));
    await applyQuickEdits(file, [editFor(original, 2, 2, "こんばんは")], false);

    assert.equal(await readFile(file, "utf8"), "hello\nこんばんは\nbye");
  });

  it("rejects stale start hashes atomically", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const stale = editFor(["one", "OLD", "three"], 2, 2, "TWO");

    await assert.rejects(() => applyQuickEdits(file, [stale], false), /hash mismatch/);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("rejects stale end hashes atomically", async () => {
    const file = await tempFile("sample.txt", "one\ntwo\nthree\n");
    const edit = editFor(["one", "two", "OLD"], 2, 3, "TWO");

    await assert.rejects(() => applyQuickEdits(file, [edit], false), /hash mismatch/);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  });

  it("rejects overlapping ranges atomically", async () => {
    const original = ["a", "b", "c", "d"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyQuickEdits(file, [editFor(original, 1, 3, "x"), editFor(original, 3, 4, "y")], false),
      /overlapping edit ranges/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });

  it("rejects out-of-bounds and reversed ranges atomically", async () => {
    const original = ["a", "b"];
    const file = await tempFile("sample.txt", original.join("\n"));

    await assert.rejects(
      () => applyQuickEdits(file, [{ startLine: 3, startHash: 0, endLine: 3, endHash: 0, content: "x" }], false),
      /out of bounds/,
    );
    await assert.rejects(
      () => applyQuickEdits(file, [{ startLine: 2, startHash: lineHash("b"), endLine: 1, endHash: lineHash("a"), content: "x" }], false),
      /end < start/,
    );
    assert.equal(await readFile(file, "utf8"), original.join("\n"));
  });
});
