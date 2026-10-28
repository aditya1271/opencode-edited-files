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

OpenCode loads plugins listed in the `plugins` array of its config file. An entry can be either a **folder path**,
which OpenCode loads from disk, or an **npm package name**, which OpenCode downloads from npmjs.com. OpenCode does not
download plugins from GitHub URLs, so to use the GitHub code you clone it and give OpenCode the folder path.

Use **one** of the methods below, not both.

### Method A: clone from GitHub

1. Clone the repository. Any folder works; this example uses your home folder:

   ```sh
   git clone https://github.com/aditya1271/opencode-edited-files.git ~/opencode-edited-files
   ```

2. Get the full path of the clone; you need it in the next step:

   ```sh
   cd ~/opencode-edited-files
   pwd
   ```

   This prints something like `/home/alice/opencode-edited-files`.

3. Open the global OpenCode config, `~/.config/opencode/opencode.json`. Create the file if it does not exist.

4. Add the path from step 2 to the `plugins` array. Use the full path; `~` is not expanded here.

   If the file is new or has no `plugins` entry yet:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/home/alice/opencode-edited-files"]
   }
   ```

   If it already has a `plugins` array, add the path to it and keep the existing entries:

   ```jsonc
   "plugins": ["some-other-plugin", "/home/alice/opencode-edited-files"]
   ```

5. Save the file. OpenCode notices the change and loads the plugin. You do not need `npm install`, a build step or a
   restart, because OpenCode runs the TypeScript source directly. If the sidebar section does not appear, type
   `/reload` in OpenCode.

To update later:

```sh
cd ~/opencode-edited-files
git pull
```

OpenCode reloads the plugin automatically when its files change.

### Method B: from npm

This works only once the package is published on npm. Check
[npmjs.com/package/opencode-edited-files](https://www.npmjs.com/package/opencode-edited-files): if that page shows
"not found", use Method A.

1. Open `~/.config/opencode/opencode.json` (create it if needed).
2. Add the package name to `plugins`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["opencode-edited-files"]
   }
   ```

3. Save the file. OpenCode downloads the package and loads it. No cloning or `npm install` is needed.

To pin a version, use `"opencode-edited-files@0.1.0"`.

### Check that it works

1. Open or start a session in OpenCode.
2. Look at the sidebar. You should see a section **Edited Files · none yet**. If the sidebar is hidden,
   widen the terminal or toggle the sidebar.
3. Ask OpenCode to edit any file. The file appears in the section with green/red `+/-` counts.
4. Type `/edits` to open the file picker.

If the section appears **twice**, the plugin is loaded more than once. Keep only one entry for it in `plugins`, and
remove any other copy of the editor-diff plugin from `~/.config/opencode/plugins/`.

If it does not appear at all, check `~/.local/share/opencode/log/opencode.log` for lines containing
`edited-files`.

### Per-project install (optional)

To enable the plugin for one project only, put the same `plugins` entry in an `opencode.json` file in that project's
folder instead of the global config.

### Choose a different editor (optional)

Diffs open with `code --diff` by default. To use another editor CLI that supports `--diff <left> <right>`, such as
`cursor` or `code-insiders`, either:

- set the environment variable before starting OpenCode, which works with both methods:

  ```sh
  export OPENCODE_DIFF_EDITOR=cursor        # bash/zsh
  setenv OPENCODE_DIFF_EDITOR cursor        # csh/tcsh
  ```

- or, with Method B, replace the plain entry with an object:

  ```jsonc
  "plugins": [{ "package": "opencode-edited-files", "options": { "editor": "cursor" } }]
  ```

The `editor` option takes priority, then `OPENCODE_DIFF_EDITOR`, then `code`.

### Uninstall

1. Remove the entry from `plugins` and save.
2. Optionally delete the clone folder (Method A) and the saved edit history in
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
