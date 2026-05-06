# pi-quickedit

Minimal Pi extension for hash-anchored edits.

## Behavior

- Hooks Pi's core `read` result and adds `<line>:<hash>|<content>` anchors to text output.
- Adds a new `quick_edit` tool, displayed as `quick-edit`.
- Does not override Pi's built-in `edit` tool, but removes `edit` from active tools so agents use `quick_edit`.
- No config, slash commands, widgets, MCP, or external Tilth dependency.

## Install

Install from GitHub:

```bash
pi install git:github.com/sting8k/pi-quickedit
```

Or load locally from this checkout:

```bash
pi -e ./src/index.ts
```

## Usage

Read first, then use anchors with `quick_edit`:

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "start": "42:a3f",
      "end": "46:e1d",
      "content": "replacement text"
    }
  ],
  "diff": true
}
```

Omit `end` for a single-line replacement. Use `content: ""` to delete a line or range.
