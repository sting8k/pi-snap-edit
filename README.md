# pi-snap-edit

Fast, precise, script-free line edits for Pi agents. Experimental redesign branch.

## Why

Pain points from agent workflow:

- Pi's built-in edit tools are safe and precise, but exact replacements can use a lot of tokens.
- Small mismatches can cause retries, especially in large or messy edits.
- Escaped strings, quotes, backslashes, regex, and templates can turn exact replacements into escape hell.
- For complex changes, agents often use ad-hoc Python scripts, which are harder to review.
- Most search tools (`rg -n`, `grep -n`, src maps) naturally return line numbers, not custom anchors.

`pi-snap-edit` is experimenting with a simpler model: edit by line number or counted literal substitutions, but require a content file hash so stale edits are rejected.

## Behavior

- Hooks `read` output to include a short content `fileHash`.
- Adds `quick_edit` for atomic line/range replacements using 1-indexed line numbers.
- Adds `substitute_edit` for ordered counted literal substitutions inside a required line range.
- Edit tools require `fileHash`; if the file changed since `read`, no edits are applied.
- Preserves line endings, including CRLF and no-trailing-newline files.
- Rejects invalid ranges, count mismatches, and overlapping line edits without partial writes.
- Does not rewrite Pi `read` lines into custom anchors; the read hook only prepends `fileHash`.

## Install

```bash
pi install npm:pi-snap-edit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```

## Usage

First read the file or relevant range; read output includes `fileHash`:

```json
{
  "path": "src/foo.ts"
}
```

Then edit by line number with `quick_edit`:

```json
{
  "path": "src/foo.ts",
  "fileHash": "abc123",
  "edits": [
    {
      "start": 42,
      "end": 45,
      "lines": ["replacement line 1", "replacement line 2"]
    }
  ]
}
```

Omit `end` for a single-line replacement. Use `lines: []` to delete a line or range. Use `lines: [""]` to replace with one blank line. Use `start: lineCount + 1` with no `end` to insert at EOF; for an empty file, `start: 1` inserts the first line.

For literal substitutions inside a known range, use `substitute_edit`:

```json
{
  "path": "src/foo.ts",
  "fileHash": "abc123",
  "start": 40,
  "end": 120,
  "substitutions": [
    { "old": "logger.debug", "new": "logger.trace", "count": 4 }
  ]
}
```

Substitutions are literal, single-line, ordered, and counted. Use `quick_edit` for multi-line changes.

Line numbers can come from Pi `read`, `rg -n`, `grep -n`, src maps, or any CLI output. EOF insert uses the virtual line immediately after the last line. If an edit reports a stale `fileHash`, read the current file/range again and retry with updated line numbers/hash.

## Verification

```bash
npm run typecheck
npm test
npm pack --dry-run
```
