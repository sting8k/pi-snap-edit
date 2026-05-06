# pi-quickedit

Minimal Pi extension for hash-anchored edits.

## Behavior

- Hooks Pi's core `read` result and adds `<line>:<hash>|<content>` anchors to text output.
- Adds a new `quick_edit` tool, displayed as `quick-edit`.
- Does not override Pi's built-in `edit` tool.
- No config, slash commands, widgets, MCP, or external Tilth dependency.

## Usage

Load locally:

```bash
pi -e ./src/index.ts
```

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
