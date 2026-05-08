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
