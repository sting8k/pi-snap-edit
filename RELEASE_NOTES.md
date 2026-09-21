## pi-snap-edit v5.3.0

README-only maintenance release: announces the project's status and where new development happens.

### Changes

- Added a prominent `IMPORTANT` notice at the top of the README: this is an experimental project, still functional, but superseded by a different Edit approach with far fewer errors.
- New development now happens in [pi-utils](https://github.com/sting8k/pi-utils) — check it out there.
- No code or behavior changes in this release.

### Install

```bash
pi install npm:pi-snap-edit
```

### Verification

- `npm run typecheck` passed.
- `npm test` passed (0 failures).
- `npm pack --dry-run` passed.
- `git diff --check` passed.
