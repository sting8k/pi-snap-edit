## pi-snap-edit v0.2.0

Switches read anchors from line-numbered 3-hex hashes to compact 5-character hash-only anchors, reducing stale-anchor retries after line shifts in long files.

### Changes

- Changed read output anchors to `<hash>|<content>` with 5-character base32 hashes derived from SHA-256 line content.
- `quick_edit` and `structured_edit` now accept hash-only anchors.
- Anchor resolution searches the current file and applies only when the hash matches exactly one current line.
- Duplicate/colliding hashes are shown as `-----|content` in refreshed read/context output so agents do not copy invalid direct anchors.
- Duplicate matching hashes are rejected as ambiguous instead of guessing an occurrence.
- Updated renderer, schemas, prompt guidance, README, and tests for hash-only anchors.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
