# AGENTS.md

## Project

`pi-snap-edit` is a Pi extension for fast, precise, script-free edits.

Core behavior:

- Hook Pi `read` results and add padded line numbers.
- Provide `quick_edit` for atomic line/range replacements guarded by `expectedStartLine`.
- Provide `substitute_edit` for counted literal substitutions inside explicit line ranges.
- Provide `target_edit` for exact target text `replace`/`insert`/`delete` with occurrence/count guards.
- Reject stale guards, invalid ranges, failed substitutions, target misses, and failed batches without partial writes.
- Preserve line endings, including CRLF and no-trailing-newline files.

The package is experimental. Keep changes small, explicit, and well-tested.

## Development rules

- Keep callable tool names stable: `quick_edit`, `substitute_edit`, and `target_edit`.
- Do not reintroduce the built-in `edit` tool preference; the extension should prefer `quick_edit`, `substitute_edit`, and `target_edit`.
- Do not add config, slash commands, widgets, MCP, or external editor/script dependencies unless explicitly requested.
- Avoid broad refactors. Touch only files needed for the task.
- Preserve existing style and TypeScript strictness.
- For edit behavior changes, add or update tests first or in the same change.

## Useful commands

```bash
npm run typecheck
npm test
npm pack --dry-run
```

Run all checks before commits and releases:

```bash
npm run typecheck && npm test && git diff --check
```

## Source layout

- `src/index.ts`: Pi extension registration, tool wiring, active tool lifecycle, public re-exports.
- `src/anchors.ts`: legacy line hash helpers.
- `src/text.ts`: line splitting and line-ending detection.
- `src/diff.ts`: diff formatting and merged refreshed context output.
- `src/schemas.ts`: TypeBox schemas and edit operation types.
- `src/quick-edit.ts`: `quick_edit` engine.
- `src/substitute-edit.ts`: `substitute_edit` engine.
- `src/target-edit.ts`: `target_edit` engine.
- `src/read-hook.ts`: `read` result line-numbering hook.
- `src/render.ts`: TUI render helpers.
- `src/active-tools.ts`: active tool preference helper.
- `test/snap-edit.test.ts`: unit and engine tests.

## Testing expectations

Cover these cases when changing edit behavior:

- stale `expectedStartLine` rejection
- atomic rollback on failure
- overlapping/reversed/out-of-bounds ranges
- counted substitutions and count mismatch
- insert/delete/replace line operations through `quick_edit`
- exact target replace/insert/delete operations through `target_edit`
- CRLF and no-trailing-newline preservation
- escape-heavy strings when relevant

For runtime confidence, use ignored fixtures under `tmp/` and actual Pi tools when possible. `tmp/` is gitignored; keep live-test artifacts there.

Suggested live-test flow:

1. Create fixtures under `tmp/live-*` for realistic files: TypeScript, JSON, CRLF text, EOF append, and atomic-failure cases.
2. Use Pi `read` to get real padded line numbers from those fixtures.
3. Exercise actual `quick_edit`, `substitute_edit`, and `target_edit` tools, not only exported engine functions.
4. Include at least one escape-heavy case with quotes, backslashes, regex, template literals, `$`, and unicode.
5. Include negative checks: stale `expectedStartLine` rejection and a later failing operation after an earlier valid in-memory change.
6. Verify exact file contents with a script, including JSON parse checks and CRLF/no-trailing-newline bytes.
7. Leave or delete `tmp/` artifacts as convenient; they should not affect git status.

## GitHub release flow

NPM publishing is handled separately. Do **not** run `npm publish` as part of this flow unless explicitly asked.

1. Verify release readiness:

   ```bash
   git status -sb
   npm run typecheck && npm test && git diff --check
   npm pack --dry-run
   ```

2. Ensure `package.json` and `package-lock.json` already contain the intended version.

3. Commit release/version/doc changes if needed:

   ```bash
   git add package.json package-lock.json README.md
   git commit -m "Release vX.Y.Z"
   ```

4. Create an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "pi-snap-edit vX.Y.Z"
   ```

5. Push commit and tag:

   ```bash
   git push origin master --tags
   ```

6. Create the GitHub release:

   ```bash
   gh release create vX.Y.Z \
     --repo sting8k/pi-snap-edit \
     --title "pi-snap-edit vX.Y.Z" \
     --notes-file RELEASE_NOTES.md
   ```

   Keep release notes detailed enough but not noisy:

   - what changed
   - install command if relevant
   - behavior or compatibility notes
   - verification summary

7. Verify release:

   ```bash
   gh release view vX.Y.Z --repo sting8k/pi-snap-edit --json tagName,name,url,isDraft,isPrerelease
   git rev-parse --short HEAD
   git rev-parse --short origin/master
   git rev-parse --short vX.Y.Z
   ```

## Release note template

```md
## pi-snap-edit vX.Y.Z

Short summary of the release.

### Changes

- Change 1.
- Change 2.

### Install

\```bash
pi install npm:pi-snap-edit
\```

### Verification

- `npm run typecheck` passed.
- `npm test` passed.
- `npm pack --dry-run` passed.
```
