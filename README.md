# pi-snap-edit

Fast, precise line edits for Pi. Experimental.

## Why

Pain points from agent workflow:

- Pi's built-in edit tools are safe and precise, but exact replacements can use a lot of tokens.
- Small mismatches can cause retries, especially in large or messy edits.
- Escaped strings, quotes, backslashes, regex, and templates can turn exact replacements into escape hell.
- For complex changes, agents often use ad-hoc Python scripts, which are harder to review.
- Most search tools (`rg -n`, `grep -n`, src maps) naturally return line numbers, not custom anchors.

`pi-snap-edit` uses a narrower model: edit by line number with required start-line content guards, or counted literal substitutions. It trades whole-block exact matching for smaller, easier-to-review tool calls; re-read before editing when line positions may have shifted.

## Why not hash-line anchors

Earlier versions centered the main read-driven workflow on `<line>:<hash>|<content>` anchors. In practice, the first successful edit made the rest of the read output stale. Current `read` output uses line numbers instead.

## Behavior

`pi-snap-edit` makes `quick_edit` and `substitute_edit` the preferred active editing tools. They are easier for agents to drive when the target lines are already known from `read`, `rg -n`, `grep -n`, or source maps.

| Need | Pi core edit tool | pi-snap-edit |
| --- | --- | --- |
| Small exact text replacement | Best when the exact old text is short and easy to quote | Works, but `quick_edit` needs line number + `expectedStartLine` |
| Large block replacement | Requires sending the full exact old block | Replace by 1-indexed line/range with `quick_edit` |
| Escape-heavy text (quotes, backslashes, regex, templates) | Can get noisy because old/new text must be escaped | Easier: replace whole lines or use counted literal substitutions |
| Output from `rg -n` / `grep -n` | Usually needs another read or exact old text | Directly usable with line numbers and `expectedStartLine` |
| Concurrent file changes | Exact old text must still match | Start-line guarded; re-read when line positions may have shifted |
| Duplicate/repeated blocks | Exact text can be more precise | Use explicit line numbers plus `expectedStartLine` |
| Reviewability | Shows exact replacement intent | Avoids ad-hoc scripts; tool output shows diff + line-numbered refreshed context |

Tool behavior:

- `read` output includes padded line numbers; offset reads keep absolute file line numbers.
- On session start, the extension removes Pi's built-in `edit` tool from the active set and adds `quick_edit` plus `substitute_edit`.
- `quick_edit` performs atomic line/range replacements using 1-indexed line numbers; requires `expectedStartLine` for each edit.
- `expectedStartLine` guards the current `start` line only; it does not verify the full range or detect line shifts from insertions/deletions above.
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
