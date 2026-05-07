## pi-snap-edit v0.1.4

Adds concise structural preflight guidance for `structured_edit` arguments so invalid op shapes produce actionable errors instead of noisy union validation output.

### Changes

- Added strict preflight checks for `structured_edit` argument structure before TypeBox union validation.
- Added concise errors for malformed `scope`, missing/empty `ops`, non-object ops, invalid op types, and missing required op fields.
- Included correct syntax examples in guidance errors for common structured operations.
- Kept behavior strict: invalid inputs are rejected, not auto-normalized.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `git diff --check` passed.
- `npm pack --dry-run` passed.
