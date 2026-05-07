## pi-snap-edit v0.1.2

Clarifies anchor usage in tool prompts and docs so agents copy only the `<line>:<hash>` prefix, not the full read line with `|content`.

### Changes

- Tightened `quick_edit` and `structured_edit` prompt wording around anchor-only fields.
- Updated schema descriptions for `start`, `end`, `scope`, and `anchor` fields to warn against including `|content`.
- Added README usage guidance showing that only the anchor prefix should be copied.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `git diff --check` passed.
- `npm pack --dry-run` passed.
