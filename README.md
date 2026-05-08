# pi-snap-edit

Fast, precise, script-free line edits for Pi agents. Experimental redesign branch.

## Why

Pain points from agent workflow:

- Pi's built-in edit tools are safe and precise, but exact replacements can use a lot of tokens.
- Small mismatches can cause retries, especially in large or messy edits.
- Escaped strings, quotes, backslashes, regex, and templates can turn exact replacements into escape hell.
- For complex changes, agents often use ad-hoc Python scripts, which are harder to review.
- Most search tools (`rg -n`, `grep -n`, src maps) naturally return line numbers, not custom anchors.

`pi-snap-edit` uses a simpler model: edit by line number or counted literal substitutions, but require a content file hash so stale edits are rejected.

## Behavior

- Hooks `read` output to include a short content `fileHash` and visible `1| ` line numbers.
- Adds `quick_edit` for atomic line/range replacements using 1-indexed line numbers.
- Adds `substitute_edit` for ordered counted literal substitutions inside a required line range.
- Edit tools require `fileHash`; if the file changed since `read`, no edits are applied.
- Preserves line endings, including CRLF and no-trailing-newline files.
- Rejects invalid ranges, count mismatches, and overlapping line edits without partial writes.
- Does not rewrite Pi `read` lines into custom hash anchors; the read hook prepends `fileHash` and visible line numbers only.

## Why not line anchors

Earlier designs rewrote `read` output as `<line>:<hash>|<content>` anchors and edited by those anchors. That failed in common agent loops:

- After any successful edit, old anchors became stale and could not safely identify current lines.
- Multi-line changes were easy to express with the wrong operation, especially when an agent tried to use single-line substitution for a multi-line replacement.
- Hash/anchor mismatches forced a fresh read anyway, and returning the current hash on failure would let agents retry without reading the file.

The current model avoids those failures: line numbers are visible directly in `read` output and normal tools, edits require the latest `fileHash`, stale failures do not reveal the current hash, and agents must read again before retrying.

## Install

```bash
pi install npm:pi-snap-edit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```

## Usage

First read the file or relevant range; read output includes `fileHash` plus padded line numbers such as ` 98| ` and `100| `. Offset reads keep absolute file line numbers, not chunk-local numbers.

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
      "expectedStartLine": "old line 42",
      "lines": ["replacement line 1", "replacement line 2"]
    }
  ]
}
```

Omit `end` for a single-line replacement. Use `lines: []` to delete a line or range. Use `lines: [""]` to replace with one blank line. Use `start: lineCount + 1` with no `end` to insert at EOF; for an empty file, `start: 1` inserts the first line. Use `expectedStartLine` as an optional exact guard for the current `start` line only; it does not check the full range.

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

Line numbers can come from Pi `read` (`1| ` / `100| ` prefixes), `rg -n`, `grep -n`, src maps, or any CLI output. EOF insert uses the virtual line immediately after the last line. If an edit reports a stale `fileHash`, read the current file/range again and retry with updated line numbers/hash.

## Verification

```bash
npm run typecheck
npm test
npm pack --dry-run
```
