# pi-snap-edit

Fast, precise, script-free edits for Pi agents.

## Behavior

- Hooks Pi's core `read` result and adds `<line>:<hash>|<content>` anchors to text output.
- Adds `quick_edit` (`quick-edit`) for direct anchored line/range replacements.
- Adds `structured_edit` (`structured-edit`) for scoped counted substitutions and anchored insert/delete/replace operations.
- Does not override Pi's built-in `edit` tool, but removes `edit` from active tools so agents use `quick_edit` or `structured_edit`.
- No config, slash commands, widgets, MCP, or external editor dependency.

## Install

Install from GitHub:

```bash
pi install git:github.com/sting8k/pi-snap-edit
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
      "lines": ["replacement line 1", "replacement line 2"]
    }
  ]
}
```

Omit `end` for a single-line replacement. Use `lines: []` to delete a line or range. Use `lines: [""]` to replace with one blank line.

Use `structured_edit` when several small operations inside a long block are cleaner than rewriting the whole block:

```json
{
  "path": "src/foo.ts",
  "scope": { "start": "120:abc", "end": "260:def" },
  "ops": [
    {
      "type": "substitute",
      "old": "logger.debug",
      "new": "logger.trace",
      "count": 4
    },
    {
      "type": "insert_after",
      "anchor": "180:a3f",
      "lines": ["  client.setTimeout(timeout);"]
    },
    {
      "type": "delete_lines",
      "start": "210:aaa",
      "end": "214:bbb"
    }
  ]
}
```

`substitute` is single-line and uses `count` as an assertion. Use `replace_lines`, `delete_lines`, `insert_before`, or `insert_after` for line-oriented changes.

For EOF append, use `structured_edit` with `insert_after` on the last anchored line. `quick_edit` intentionally edits existing anchored lines/ranges only; it does not accept synthetic line numbers past EOF.
