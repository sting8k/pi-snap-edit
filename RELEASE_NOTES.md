## pi-snap-edit v0.1.5

Improves agent guidance for choosing between `quick_edit` batching and `structured_edit`, and makes stale-anchor failures clearer.

### Changes

- Clarified `quick_edit` guidance: use it for one range or batch independent ranges from the same latest read.
- Clarified when to reuse anchors from latest tool output versus reading again.
- Clarified `structured_edit` guidance for several edits in one file and anchored range replacements.
- Reworded stale hash failures as stale anchors and explicitly state that no edits were applied.
- Added current-content review guidance before retrying with a new anchor.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `git diff --check` passed.
- `npm pack --dry-run` passed.
- Live smoke test under `tmp/live-smoke` passed with actual `read`, `quick_edit`, and `structured_edit` tools.
