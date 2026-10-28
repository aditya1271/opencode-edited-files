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

You only need to edit one config file. Choose **one** of the two options below.

### Option 1: from npm (recommended, no cloning)

1. Open your global OpenCode config, `~/.config/opencode/opencode.json`. Create it if it does not exist. To enable the
   plugin for a single project only, use `opencode.json` in that project's folder instead.
2. Add `"opencode-edited-files"` to the `plugins` array:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["opencode-edited-files"]
   }
   ```

   If the file already has other settings or plugins, keep them and only add this entry to the array.
3. Save the file. OpenCode downloads the package from npm and loads it automatically. You do not need to run
   `npm install`, clone anything or restart OpenCode. If it does not appear, run `/reload` in OpenCode.

To pin a version, use `"opencode-edited-files@0.1.0"`.

### Option 2: from a GitHub clone

Use this to run the latest unreleased code or to modify the plugin.

1. Clone the repository anywhere:

   ```sh
   git clone https://github.com/aditya1271/opencode-edited-files.git ~/opencode-edited-files
   ```

2. Add the **absolute path** of the clone to `plugins` in `~/.config/opencode/opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/home/<you>/opencode-edited-files"]
   }
   ```

3. Save the file. OpenCode loads the TypeScript source directly, so you do not need `npm install` or a build step.

To update, run `git pull` in the clone.

### Check that it works

Open a session and look at the sidebar. A section titled **Edited Files · none yet** should appear. Ask OpenCode to
edit a file, and the file appears in the list with its `+/-` counts. Typing `/edits` should open the picker.

Only use one copy: do not use both options at once or alongside another copy of the editor-diff plugin, or the
section appears twice.

### Choose a different editor (optional)

Diffs open with `code --diff` by default. To use another editor CLI that supports `--diff <left> <right>`, such as
Cursor or VS Code Insiders, replace the plain entry with an object:

```jsonc
{
  "plugins": [{ "package": "opencode-edited-files", "options": { "editor": "cursor" } }]
}
```

The editor is chosen from the `editor` option, then the `OPENCODE_DIFF_EDITOR` environment variable, then `code`.

### Uninstall

Remove the entry from `plugins` and save. To delete the saved edit history too, remove
`~/.local/state/opencode-edited-files/`.

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
