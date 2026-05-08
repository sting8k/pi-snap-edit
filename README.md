# pi-snap-edit

Fast, precise line edits for Pi. Experimental.

## Why

Pain points from agent workflow:

- Pi's built-in edit tools are safe and precise, but exact replacements can use a lot of tokens.
- Small mismatches can cause retries, especially in large or messy edits.
- Escaped strings, quotes, backslashes, regex, and templates can turn exact replacements into escape hell.
- For complex changes, agents often use ad-hoc Python scripts, which are harder to review.
- Most search tools (`rg -n`, `grep -n`, src maps) naturally return line numbers, not custom anchors.

`pi-snap-edit` uses a simpler model: edit by line number with required line content guards, or counted literal substitutions. More convenient than exact text replacement, but less safe against concurrent changes or duplicate lines.

## Why not hash-line anchors

Earlier versions used `<line>:<hash>|<content>` anchors. In practice, the first successful edit made the rest of the read output stale. Agents then tried to keep working from dead anchors, mixed up single-line and multi-line operations, or needed another full read before every next change.

## Behavior

- `read` output includes `fileHash` (for agent state tracking) and padded line numbers; offset reads keep absolute file line numbers.
- `quick_edit` performs atomic line/range replacements using 1-indexed line numbers; requires `expectedStartLine` for each edit.
- `expectedStartLine` guards the current `start` line only; does not verify the full range or detect line shifts from insertions/deletions above.
- `substitute_edit` performs ordered, counted, literal single-line substitutions inside a required range; no content guards.
- Line endings are preserved, including CRLF and no-trailing-newline files.
- Invalid ranges, count mismatches, overlapping edits, and `expectedStartLine` mismatches are rejected without partial writes.

## Install

```bash
pi install npm:pi-snap-edit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```
