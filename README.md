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

`pi-snap-edit` uses a narrower model: edit by line number with required start-line content guards, or exact target text with line/range selectors. It trades whole-block exact matching and ad-hoc scripts for smaller, easier-to-review tool calls; re-read before editing when line positions may have shifted.

## Why not hash-line anchors

Earlier versions centered the main read-driven workflow on `<line>:<hash>|<content>` anchors. In practice, the first successful edit made the rest of the read output stale. Current `read` output uses line numbers instead.

## Behavior

`pi-snap-edit` currently registers `quick_edit` and `target_edit` as preferred active editing tools. Use line-numbered edits when target lines are known; use `target_edit` when the stable handle is exact text/marker content instead.

| Need | Pi built-in edit | pi-snap-edit |
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
- `quick_edit` line edits replace their span; there is no mid-file insert. Append at EOF with `start: "eof"`, or insert mid-file with `target_edit` `insert_before`/`insert_after` (or by replacing a line with `[newLines..., originalLine]`).
- Replacement entries containing real newlines are split into separate lines, so line endings and reported line counts stay consistent.
- Guard mismatches report the first differing column (or the missing tail when the guard is a prefix) and suggest a copy-paste `expectedStartLine` that is verified to match on resend.
- `quick_edit` defaults to exact guard matching. Use `expectedStartLineMatch: "trim"` plus `preserveIndent: true` when indentation/trailing whitespace is uncertain and replacement lines should inherit the current line indentation.
- `target_edit` performs ordered exact-target operations: `replace`, `delete`, `insert_before`, and `insert_after`.
- For `replace` and `delete`, selectors are flexible: omit both `line`/`range` when the target is unique in the file; use `line` for one occurrence on a line; use `range` for every occurrence fully inside an inclusive line range; or combine `line` + `range` to scope by range and verify one selected occurrence intersects the line.
- `insert_before` and `insert_after` require `line` and insert full lines before/after the target occurrence.
- `target_edit` matches in tiers automatically: exact substring, then the unescaped target, then whole-line trim matching. Trim matching only runs when the earlier tiers find nothing, so an exact hit stays authoritative.
- On a trim match, `replace` stays bounded to the trimmed content so the file's original indentation is preserved and replacement edge whitespace is stripped, while `delete` removes the whole matched line(s) instead of leaving an indentation-only blank line. Exact and unescaped matches keep literal substring semantics for both.
- When a match is not exact, the tool output says how it matched (`matched via trim ...` or `matched via unescape ...`) so the target can be corrected. Exact matches stay silent.
- `matchMode: "trim"` is still accepted and forces trim-only matching (exact substring matches are ignored), which is useful when the target text also appears inside an indented line.
- On a trim match, a uniform indentation shift between the target and the matched block is applied to the rest of the replacement lines, so multi-line replacements written at drifted indentation land at the file's indentation.
- Line endings are preserved, including CRLF and no-trailing-newline files. `read` and edit output note these properties when a file is not plain LF with a trailing newline, so byte state is visible without external inspection.
- Diff headers use post-edit line numbers, matching the refreshed context below them. An operation that changes more than one occurrence reports the count.
- Invalid `quick_edit` ranges/overlaps, invalid `target_edit` selectors/ranges, target misses, and `expectedStartLine` mismatches are rejected without partial writes.
- Failure hints may list moved/close matches with line numbers. Multi-line target misses can include first-line near matches, last-line near matches, and capped anchor block candidates. Fuzzy hints are diagnostic-only and never applied automatically.

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

Rules: `target` is exact literal text; whole-line trim matching kicks in automatically when exact and unescaped matching both miss. Use `matchMode: "trim"` to force trim-only matching. `replace`/`delete` may use no selector, `line`, `range`, or `line` + `range` as described above. `insert_before`/`insert_after` require `line`. `replace` uses `replacement` text.

## Install

```bash
pi install npm:pi-snap-edit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```

## Eval harness

This repo includes a small prompt-guideline eval harness. It compares "informed" tool calls that follow the documented guidance against simpler naive calls, then reports which guidelines changed outcomes.

```bash
npx tsx test/eval-guidelines.ts
```

Use it as a documentation sanity check when changing tool guidance or edit semantics; it is not a replacement for `npm test`.
