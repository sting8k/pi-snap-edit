## pi-snap-edit v5.0.0

Breaking release. `target_edit` now cascades through match tiers automatically instead of requiring `matchMode: "trim"`, and reports the tier whenever a match is not exact. Also removes `substitute_edit` entirely.

### Changes

- **Automatic match cascade for `target_edit`:** matching now falls through exact substring → unescaped target → whole-line trim. The trim tier only runs when both earlier tiers miss, so a unique exact hit is never diluted into an ambiguous reject. Indentation or trailing-whitespace drift succeeds without a retry, saving a read/edit round-trip.
- **Match tier reporting:** when a match is not exact, the tool output states how it matched (`matched via trim (indentation or trailing whitespace differed)` or `matched via unescape (escape sequences in target were normalized)`), prefixed with `op[N]` in multi-op batches. Exact matches stay silent. Relaxed matching is deliberately visible so a wrong-but-plausible match can be caught rather than applied quietly.
- **Trim semantics gated on occurrence kind:** replacement edge trimming now keys off the resolved occurrence being a trim match rather than the caller's `matchMode`. Auto-cascade and explicit `matchMode: "trim"` produce byte-identical output for the same input; previously the auto path would double the indentation.
- **`matchMode` unchanged in meaning:** still accepted, still forces trim-only matching and ignores exact substring hits — useful when the target text also appears inside an indented line.
- **Removed `substitute_edit`:** unregistered as a callable tool since v3.0.0; its engine, schema, and exports are now gone. The `substitute_edit` filter in active-tool preference is kept so saved state from older sessions is still cleaned up.
- **Docs:** README, `target_edit` promptGuidelines, and the `matchMode` schema description updated to describe the cascade instead of instructing callers to opt into trim.

### Breaking

- `applySubstituteEdits` and the `Substitution` type are no longer exported.
- `target_edit` succeeds on some inputs that previously failed with `target not found`. Callers relying on strict exact-only matching should pass `matchMode: "exact"`-equivalent unique targets, or a `line`/`range` selector.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (97 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.
- A/B verified against the previous commit: auto-cascade output is identical to explicit `matchMode: "trim"` across single-line, no-indent replacement, multi-line block, `delete`, and CRLF/no-trailing-newline cases; exact-path behavior (exact hit beside a trim occurrence elsewhere, literal replacement, unescape fallback, `line` selector, explicit trim) is unchanged; ambiguous trim matches still reject.

---

## pi-snap-edit v4.2.1

Patch release. Makes edit failures machine-readable via structured error payloads, and improves `quick_edit` usability with `start="eof"` appends, an `indent_tolerant` whitespace shortcut, and optional end-line/count guards — all without weakening fail-closed atomic semantics.

### Changes

- **Structured failures:** new `SnapEditError` with stable `error_code`, optional `candidates` / `suggested` retry fields, and a trailing `--- snap-edit-error ---` JSON block. Exports `parseSnapEditError` / `SnapEditError` for engines, tools, and tests. `quick_edit` and `target_edit` validation/mismatch paths now route through `throwEditError`, keeping human diagnostic prose above the JSON.
- **`quick_edit` UX:**
  - Prefer `start="eof"` for appends (no `expectedStartLine` required); legacy `start=lineCount+1` inserts still work.
  - New `whitespace="indent_tolerant"` shortcut (trim guards + `preserveIndent`); explicit `expectedStartLineMatch` / `preserveIndent` still override.
  - Optional `expectedEndLine` and `expectedLineCount` guards for safer multi-line range edits.
  - Actionable `suggested` retry fields surfaced on errors (relocated start, `indent_tolerant`).
- **Tool guidance:** documented `eof`, whitespace shortcut, range guards, and structured error parsing in `quick_edit` / `target_edit` promptGuidelines.
- **Tests:** added coverage for structured parse paths, `eof` append, `indent_tolerant`, end/count guards, and target ambiguous/not-found structured payloads.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (93 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v4.2.0

Minor release. Adds `matchMode=trim` for whitespace-tolerant target matching, relaxes `line`/`range` selector rules for `replace`/`delete`, and surfaces multi-line diagnostic hints when a multi-line target fails to match.

### Changes

- **`matchMode: "exact" | "trim"` for `target_edit`:** opt-in line-level matching that compares content after `trim()` per line, preserving original indentation on replace/delete. Non-whitespace content must still match exactly; only leading/trailing line whitespace is forgiven. Match priority: `exact > unescape > trim`. Replaces/deletes are bounded to the trimmed content only — never consumes the line-terminating newline. Replacement leading/trailing whitespace is stripped in trim mode to avoid double-indent when agents copy indentation into the replacement.
- **Relaxed `line`/`range` selector rules:** four modes now allowed on `replace`/`delete` — `line` only (1 occurrence intersect line), `range` only (every occurrence in range), both (range selects + line is a validation hint: at least one occurrence must intersect it), neither (target must be unique in the file, else fail with a clear message). Removes the prior mutually-exclusive constraint that caused awkward agent errors.
- **Multi-line diagnostic hints:** when a multi-line `target_edit` target fails to match, errors now include first/last line near matches (dice coefficient) and anchor block candidates where first + last lines match by trim. Diagnostic only; never auto-applied. Anchor block display capped at 10 lines (3 + ellipsis + 3) to keep output bounded.
- **Test infrastructure:** added `test/eval-guidelines.ts` standalone eval harness to measure which prompt guidelines actually impact success rate (25 tasks × 12 categories × informed/naive variants).
- **README:** aligned with the new target edit semantics and four selector modes.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (76 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v4.1.0

Minor release. Improves escape-heavy edit matching and preserves UTF-8 BOM across edit tools and numbered read output.

### Changes

- **Escaped edit targets:** `quick_edit` `expectedStartLine` and `target_edit` `target` try raw match first, then JSON-style unescaped fallback (`\n`, `\t`, `\\`, etc.). Raw matches win over fallback to avoid double-apply on overlap.
- **UTF-8 BOM preservation:** only one leading file-level BOM is tracked; `quick_edit`, `substitute_edit`, and `target_edit` preserve it on write. Read hook hides the file BOM on line 1 while keeping content `\uFEFF` characters visible.
- **Tests:** added coverage for escape guards, raw-over-fallback selectors, and byte-level BOM cases.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (56 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.
- Live-tested `read`, `quick_edit`, and `target_edit` after Pi reload.

---

## pi-snap-edit v4.0.0

Breaking API cleanup release. Simplifies `target_edit` selectors and op types, improves `quick_edit` guard flexibility, and adds diagnostic fuzzy hints on edit failures.

### Changes

- **`target_edit` breaking cleanup:** removed `occurrence`/`count`/`position` params. Replaced with `line`/`range` selectors and `insert_before`/`insert_after` op types. Removed top-level `scope`.
- **`quick_edit` trim guard:** added `expectedStartLineMatch: "trim"` and `preserveIndent: true` to handle whitespace uncertainty without failing.
- **Diagnostic fuzzy hints:** when `quick_edit` guard or `target_edit` target fails to match, the tool now lists close matches with line numbers and snippets for faster retry.
- **Runtime validation:** `line` and `range` selectors now validate integer/min/bounds/order. Unknown op types are explicitly rejected.

### Breaking Changes

- `target_edit` no longer supports `occurrence`, `count`, `position`, or top-level `scope`.
- `target_edit` `insert` + `position` replaced by `insert_before` and `insert_after`.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (44 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v3.0.3

Patch release. Fixes read hook line numbering for CRLF files so `quick_edit` guards copied from `read` output do not include hidden carriage returns.

### Changes

- Normalized `read` hook line splitting through the shared `splitLines` helper.
- Fixed CRLF read output so numbered lines no longer retain hidden `\r` characters.
- Preserved continuation notice handling for CRLF read output.
- Added regression tests for CRLF numbered reads and `quick_edit` expectedStartLine guards copied from read output.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (33 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v3.0.0

Breaking release. Temporarily disables the callable `substitute_edit` tool while keeping its engine/export available for compatibility and rollback.

### Changes

- Removed `substitute_edit` from Pi tool registration.
- Removed `substitute_edit` from preferred active tools and actively filters stale active `substitute_edit` entries on session start.
- Kept `applySubstituteEdits` export and engine tests intact.
- Updated README, AGENTS, and active-tool tests to reflect the active tool set: `quick_edit` and `target_edit`.

### Breaking Changes

- `substitute_edit` is no longer available as a callable Pi tool.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (31 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v2.1.1

Patch release. Improves `quick_edit` stale line recovery and clarifies batch semantics for agents.

### Changes

- `quick_edit` expectedStartLine mismatch errors now search for the expected line elsewhere in the file and include line-numbered ±5 context when found.
- Keeps the no-match fallback terse without exposing the unexpected line content at the requested position.
- Clarified prompt guidance: `quick_edit` batch edits are snapshot-based, not sequential; do not renumber later edits after earlier insert/delete ops.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (31 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.

---

## pi-snap-edit v2.1.0

Feature release. Adds `target_edit` for exact-target edits when agents know stable marker text but line numbers are inconvenient.

### Changes

- Added `target_edit` callable tool with three operations: `replace`, `insert`, and `delete`.
- Added occurrence/count guards and optional line scope for exact target matching.
- `target_edit` preserves line endings, supports multi-line targets/replacements, and returns diff plus line-numbered refreshed context.
- Rebases target edit diff/context positions after later line-shifting operations in the same batch.
- Added tests and docs for target-based editing, atomic failures, CRLF/no-trailing-newline preservation, and batch line-shift output.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (30 tests).
- `git diff --check` passed.
- `npm pack --dry-run` passed.
- Live Pi tool tests passed after reload.

---

## pi-snap-edit v2.0.0

Breaking cleanup release. Removes the hash-anchored `structured_edit` workflow and standardizes the active workflow around line-numbered `quick_edit` plus `substitute_edit`.

### Changes

- Removed the `structured_edit` callable tool and its public exports.
- Removed structured edit schemas, engine, anchor parsing helpers, and tests.
- Changed refreshed edit context output to absolute padded line numbers, so follow-up `quick_edit` calls can use the returned context directly.
- Updated README and AGENTS guidance to match the current line-number workflow.

### Breaking Changes

- `structured_edit` is no longer registered or exported.
- `applyStructuredEdits`, `StructuredEditOp`, `StructuredEditParams`, `parseAnchor`, and `invalidAnchorMessage` are no longer exported.
- Refreshed context output is now `line| content` instead of `HASH|content`.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (23 tests).
- `npm pack --dry-run` passed.

---

## pi-snap-edit v1.1.1

Hotfix release. Restored numbered read output that was accidentally removed in v1.1.0.

### Changes

- Restored numbered read output (line numbers with padding).
- Read output still does not include `fileHash` header (as intended in v1.1.0).
- Fixed read hook to properly handle offset reads and image files.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (47 tests).

---

## pi-snap-edit v1.1.0

Simplified output release. Removed `fileHash` from read hook and edit responses, removed hash prefix from diff output, and fixed security leak in error messages.

### Changes

- Removed `fileHash` from `read` output (no longer injected by read hook).
- Removed `fileHash` from `quick_edit` and `substitute_edit` success responses.
- Removed hash prefix from diff output: now shows `- content` / `+ content` instead of `- HASH|content` / `+ HASH|content`.
- Fixed security issue: `expectedStartLine` mismatch errors no longer leak actual line content.
- Made `expectedStartLine` required for all `quick_edit` operations.

### Breaking Changes

- `read` output no longer includes `fileHash` header.
- Edit tool responses no longer include `fileHash`.
- Diff output format changed (no hash prefix).

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (47 tests).
- `npm pack --dry-run` passed.

---

## pi-snap-edit v1.0.0

Line-numbered editing release. `read` now shows a file-level `fileHash` and readable line numbers, while edit tools reject stale hashes without exposing a retry oracle.

### Changes

- Replaced hash-line anchors with padded `read` line numbers and a required file-level `fileHash`.
- Added `expectedStartLine` to `quick_edit` as an optional exact guard for the current `start` line only.
- Added `substitute_edit` for counted literal substitutions inside a required line range.
- Preserved absolute line numbers for offset reads and padded line-number columns around 10/100+ lines.
- Fixed final-newline edge cases so `read` does not show phantom EOF lines or continuation notices.
- Updated README and tests for the line-numbered workflow.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `npm pack --dry-run` passed.
