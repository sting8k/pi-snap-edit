## pi-snap-edit v0.1.3

Improves agent-facing guidance for structured edits and invalid anchors.

### Changes

- Added a compact correct-shape example to `structured_edit` prompt guidance.
- Added concise malformed `scope` guidance with the correct JSON syntax.
- Improved invalid anchor errors to tell agents to copy only the `<line>:<hash>` prefix before `|`.
- Tightened anchor parsing so anchors with trailing `|content` are rejected instead of partially parsed.
- Added a clearer `replace_lines` hint when `substitute` is used with multi-line strings.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `git diff --check` passed.
- `npm pack --dry-run` passed.
