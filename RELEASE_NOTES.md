## pi-snap-edit v1.1.0

Simplified output release. Removed `fileHash` from read hook and edit responses, removed hash prefix from diff output, and fixed security leak in error messages.

### Changes

- Removed `fileHash` from `read` output (no longer injected by read hook).
- Removed `fileHash` from `quick_edit` and `substitute_edit` success responses.
- Removed hash prefix from diff output: now shows `- content` / `+ content` instead of `- HASH|content` / `+ HASH|content`.
- Fixed security issue: `expectedStartLine` mismatch errors no longer leak actual line content.
- Made `expectedStartLine` required for all `quick_edit` operations.
- Context output still includes hash format `HASH|content` for `structured_edit` references.

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
