# opencode-edited-files

An [OpenCode](https://opencode.ai) V2 plugin that lists every file a session has edited in the sidebar, next to MCP and
Subagents, with `+/-` line counts and one-click diffs in VS Code.

```
▼ Edited Files 4 +31 -10
view: whole session | last turn
src/
  M tui.tsx +19 -11
  M index.ts +28 -10
docs/
  A usage.md +2 -0
```

## Features

- **Sidebar section** listing the files edited in the current session, including edits made by its subagents.
- **Status and counts**: `A` added, `M` modified, `D` deleted, with green/red `+/-` line counts and header totals.
- **Two views**, switched by clicking the `view:` line:
  - **whole session**: every edited file, compared with how it was before the session first touched it.
  - **last turn**: only files edited since your latest prompt, compared with how they were before that turn.
- **Grouped by folder**, 10 rows by default with a `show all / show less` toggle. Click the header to collapse.
- **Click a file to open its diff** in VS Code (`code --diff`). Diffs never open automatically.
- **`/edits` picker** with every file, grouped by folder and searchable. `Ctrl+A` opens all diffs (asks first above
  10), `Ctrl+T` switches the view.
- **Persistent**: the edit list and "before" copies survive restarts and are removed when the session is deleted.

## Install

Add the package to `plugins` in `~/.config/opencode/opencode.json` (or a project `opencode.json`). One entry loads both
the server part and the sidebar:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-edited-files"]
}
```

To use another editor CLI that supports `--diff <left> <right>` (for example Cursor or VS Code Insiders):

```jsonc
{
  "plugins": [{ "package": "opencode-edited-files", "options": { "editor": "cursor" } }]
}
```

The editor is chosen from the `editor` option, then the `OPENCODE_DIFF_EDITOR` environment variable, then `code`.

## Opening diffs

Diffs open only when OpenCode runs in a **VS Code integrated terminal** (including Remote-SSH), where
`VSCODE_IPC_HOOK_CLI` is set and `code --diff` reaches your VS Code window. In any other terminal the sidebar and counts
still work, and clicking a file shows a notice instead.

Added and deleted files are compared against an empty placeholder named `<file> (none)`, because VS Code cannot open
`/dev/null`.

## Commands

| Command | Description |
| --- | --- |
| `/edits` | Pick a file to open its diff. `Ctrl+A` opens all, `Ctrl+T` switches the view. |
| `/edits-view` | Switch between **whole session** and **last turn**. |

Both are also in the command palette under **Edited files**.

## Storage

State lives in `$XDG_STATE_HOME/opencode-edited-files/` (default `~/.local/state/opencode-edited-files/`), readable only
by you:

- `sessions/<sessionID>.json`: edited files, timestamps and turn tracking.
- `backups/<sessionID>/`: a copy of each file from before the session first edited it, plus one from before the latest
  turn that edited it. Older per-turn copies are replaced.

A session's data is deleted when the session is deleted. Sessions deleted while OpenCode was not running are cleaned up
on the next start, only when OpenCode reports the session as not found. There is no time-based expiry.

Sidebar preferences (collapsed, view, show all) use OpenCode's plugin storage.

## Limitations

- Only edits made through OpenCode's `edit`, `write` and `patch` tools are tracked. Changes made by shell commands
  (`sed`, `mv`, formatters run via shell) are not.
- `+/-` counts use the system `diff` command.
- If you remove backup files by hand, the affected diffs and counts are wrong.

## Requirements

- OpenCode 2.2 or later.
- `diff` on `PATH`; VS Code (or another `--diff` capable editor) for opening diffs.

## Credits

Based on [opencode-plugin-editor-diff](https://www.npmjs.com/package/opencode-plugin-editor-diff) by HoangP8, rewritten
for the OpenCode V2 plugin API.

## License

MIT
