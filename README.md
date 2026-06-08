# pi-snap-edit

Fast, precise line edits for Pi. Experimental.

## Why

Pain points from agent workflow:

- Pi's built-in edit tools are safe and precise, but exact replacements can use a lot of tokens.
- Small mismatches can cause retries, especially in large or messy edits.
- Escaped strings, quotes, backslashes, regex, and templates can turn exact replacements into escape hell.
- For complex changes, agents often use ad-hoc Python scripts, which are harder to review.
- Indentation/whitespace mismatches cause `expectedStartLine` guard to fail despite visually matching content, requiring careful copy or the use of `expectedStartLineMatch: "trim"` + `preserveIndent: true`.
- Most search tools (`rg -n`, `grep -n`, src maps) naturally return line numbers, not custom anchors.

`pi-snap-edit` uses a narrower model: edit by line number with required start-line content guards, counted literal substitutions, or exact target text with line/range selectors. It trades whole-block exact matching and ad-hoc scripts for smaller, easier-to-review tool calls; re-read before editing when line positions may have shifted.

## Why not hash-line anchors

Earlier versions centered the main read-driven workflow on `<line>:<hash>|<content>` anchors. In practice, the first successful edit made the rest of the read output stale. Current `read` output uses line numbers instead.

## Behavior

`pi-snap-edit` currently registers `quick_edit` and `target_edit` as preferred active editing tools. Use line-numbered edits when target lines are known; use `target_edit` when the stable handle is exact text/marker content instead.

| Need | Pi core edit tool | pi-snap-edit |
| --- | --- | --- |
| Small exact text replacement | Best when the exact old text is short and easy to quote | Use `target_edit` by exact target `line`/`range`, or `quick_edit` when line numbers are known |
| Large block replacement | Requires sending the full exact old block | Replace by 1-indexed line/range with `quick_edit` |
| Escape-heavy text (quotes, backslashes, regex, templates) | Can get noisy because old/new text must be escaped | Easier: replace whole lines or target a small marker |
| Output from `rg -n` / `grep -n` | Usually needs another read or exact old text | Directly usable with line numbers and `expectedStartLine` |
| Concurrent file changes | Exact old text must still match | Start-line guarded; re-read when line positions may have shifted |
| Duplicate/repeated blocks | Exact text can be more precise | Use explicit line numbers plus `expectedStartLine`, or `target_edit` with `line` or `range` |
| Reviewability | Shows exact replacement intent | Avoids ad-hoc scripts; tool output shows diff + line-numbered refreshed context |

Tool behavior:

- `read` output includes padded line numbers; offset reads keep absolute file line numbers.
- On session start, the extension removes Pi's built-in `edit` tool from the active set and adds `quick_edit` and `target_edit`.
- `quick_edit` performs atomic line/range replacements using 1-indexed line numbers; requires `expectedStartLine` for each edit.
- `expectedStartLine` guards the current `start` line only; it does not verify the full range or detect line shifts from insertions/deletions above.
- `quick_edit` defaults to exact guard matching. Use `expectedStartLineMatch: "trim"` plus `preserveIndent: true` when indentation/trailing whitespace is uncertain and replacement lines should inherit the current line indentation.
- `substitute_edit` registration is temporarily disabled; its engine remains exported for now.
- `target_edit` performs ordered exact-target operations: `replace`, `delete`, `insert_before`, and `insert_after`.
- `replace` and `delete` require exactly one selector: `line` for a single occurrence, or `range` for every occurrence fully inside an inclusive line range.
- `insert_before` and `insert_after` require `line` and insert full lines before/after the target occurrence.
- Line endings are preserved, including CRLF and no-trailing-newline files.
- Invalid ranges, target misses, overlapping edits, and `expectedStartLine` mismatches are rejected without partial writes.

## `target_edit` quick shape

```json
{
  "path": "src/file.ts",
  "ops": [
    {
      "type": "insert_after",
      "target": "const app = createApp();",
      "line": 1,
      "lines": ["app.use(logger);"]
    }
  ]
}
```

Rules: `target` is exact literal text; `replace`/`delete` choose exactly one of `line` or `range`; `insert_before`/`insert_after` require `line`; `replace` uses `replacement` text.

## Install

```bash
pi install npm:pi-snap-edit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```
