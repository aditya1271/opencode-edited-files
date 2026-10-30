import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { EditedFiles, type EditedFile } from "./rpc.ts"

/** "session": every edited file vs session start. "turn": only the last turn's files vs before that turn. */
type View = "session" | "turn" | "review"

interface Prefs {
  expanded: boolean
  baseline: View
  showAll?: boolean
  showReviewed?: boolean
  /** The Workspace and Outside workspace headings the user collapsed. */
  collapsed?: { workspace?: boolean; outside?: boolean }
}

interface Group {
  dir: string
  files: EditedFile[]
  /** Outside the session's directory. */
  outside: boolean
}

const SIDEBAR_WIDTH = 38
const COMPACT_ROWS = 10
const CONFIRM_OPEN_ABOVE = 10
const REVIEW_RECHECK_MS = 5000
const STATUS_MARK: Record<EditedFile["status"], string> = { added: "A", modified: "M", deleted: "D" }

/**
 * Diff editor command: plugin option `editor`, then $OPENCODE_DIFF_EDITOR, then `code` in a VS Code terminal and
 * `vimdiff` anywhere else. It may carry arguments, e.g. "vim -u NONE".
 */
const resolveEditor = (options: Readonly<Record<string, unknown>> | undefined): string => {
  const fromOptions = options?.editor
  if (typeof fromOptions === "string" && fromOptions.trim()) return fromOptions.trim()
  const fromEnv = process.env.OPENCODE_DIFF_EDITOR
  if (fromEnv?.trim()) return fromEnv.trim()
  return process.env.VSCODE_IPC_HOOK_CLI ? "code" : "vimdiff"
}

/**
 * How the editor opens a diff:
 * - terminal: vim/nvim in OpenCode's own terminal; the TUI is suspended until the editor quits.
 * - gui: gvim in its own window (needs $DISPLAY).
 * - cli: a `--diff <left> <right>` CLI such as code or cursor (needs a VS Code terminal).
 */
type EditorKind = "terminal" | "gui" | "cli"
const VIM_KIND: Record<string, EditorKind> = {
  vi: "terminal", vim: "terminal", vimdiff: "terminal", nvim: "terminal", view: "terminal",
  gvim: "gui", gvimdiff: "gui",
}
const editorKind = (command: string[]): EditorKind => VIM_KIND[path.basename(command[0] ?? "")] ?? "cli"

/** The plugin's own copies (backups and empty placeholders) as vim autocmd patterns. */
const OWN_COPIES = "*/opencode-edited-files/backups/*,*/opencode-edited-files-*/empty/*"

/**
 * vim arguments for one diff: the before copy (left) is read-only; the right side is the real file.
 * The copies get no swap file, and a stale one (from a killed vim) opens read-only instead of prompting.
 */
const vimDiffArgs = (command: string[], left: string, right: string) => [
  ...command.slice(1),
  "--cmd", `autocmd BufNewFile,BufReadPre ${OWN_COPIES} setlocal noswapfile`,
  "--cmd", `autocmd SwapExists ${OWN_COPIES} let v:swapchoice = 'o'`,
  ...(/diff$/.test(path.basename(command[0]!)) ? [] : ["-d"]),
  "-c", "wincmd t | setlocal readonly nomodifiable | wincmd b",
  left,
  right,
]

const NULL_DEVICE = "/dev/null"

/** VS Code cannot open /dev/null, so added/deleted files diff against an empty stand-in. */
const diffSide = (file: string, realPath: string) => {
  if (file !== NULL_DEVICE) return file
  const dir = path.join(tmpdir(), `opencode-edited-files-${userInfo().username}`, "empty")
  const placeholder = path.join(dir, `${path.basename(realPath)} (none)`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(placeholder, "")
  return placeholder
}

const truncateLeft = (text: string, width: number) =>
  text.length <= width ? text : "…" + text.slice(text.length - Math.max(width - 1, 1))

const resolveColor = (theme: unknown, tokenPath: string, fallback: string) => {
  const value = tokenPath.split(".").reduce<any>((acc, key) => acc?.[key], theme)
  return value ?? fallback
}

export default Plugin.define({
  id: "edited-files.tui",
  setup(context) {
    const editor = resolveEditor(context.options as Readonly<Record<string, unknown>> | undefined)
    const editorCommand = editor.split(/\s+/)
    const kind = editorKind(editorCommand)
    const inVSCode = !!process.env.VSCODE_IPC_HOOK_CLI
    let inTerminalEditor = false
    /** Bumped when terminal vim quits; files saved there send no event, so the sidebar re-counts them. */
    const [editorClosed, setEditorClosed] = createSignal(0)
    const rpc = context.client.rpc(EditedFiles)
    const [prefs, setPrefs] = context.storage.store<Prefs>("prefs", {
      initial: { expanded: true, baseline: "session", showAll: false },
    })
    const updatePrefs = (mutate: (draft: Prefs) => void) => void setPrefs(mutate).catch(() => {})

    const color = {
      header: () => resolveColor(context.theme, "text.base", "#eeffff"),
      muted: () => resolveColor(context.theme, "text.muted", "#546e7a"),
      added: () => resolveColor(context.theme, "text.feedback.success.base", "#c3e88d"),
      removed: () => resolveColor(context.theme, "text.feedback.error.base", "#f07178"),
      modified: () => resolveColor(context.theme, "text.feedback.warning.base", "#ffcb6b"),
      accent: () => resolveColor(context.theme, "text.action.primary.selected", "#82aaff"),
    }
    const statusColor = (file: EditedFile) =>
      file.status === "added" ? color.added() : file.status === "deleted" ? color.removed() : color.modified()

    const countsOf = (file: EditedFile) =>
      prefs.baseline === "turn"
        ? { add: file.turnAdditions, del: file.turnDeletions }
        : prefs.baseline === "review"
          ? { add: file.reviewAdditions, del: file.reviewDeletions }
          : { add: file.additions, del: file.deletions }

    const VIEW_LABELS: Record<View, string> = { session: "Whole session", turn: "Last turn", review: "Since review" }
    const viewLabel = () => VIEW_LABELS[prefs.baseline] ?? VIEW_LABELS.session

    const sessionDirectory = (sessionID: string) => context.data.session.get(sessionID)?.location?.directory

    /** Start of the root session's latest turn: the time of its newest user prompt. */
    const lastTurnStart = (sessionID: string) => {
      const root = context.data.session.root(sessionID) ?? sessionID
      let start = 0
      for (const message of context.data.session.message.list(root) ?? []) {
        if (message.type === "user" && message.time.created > start) start = message.time.created
      }
      return start
    }

    const rootOf = (sessionID: string) => context.data.session.root(sessionID) ?? sessionID
    const rpcOptions = (sessionID: string) => {
      const directory = sessionDirectory(sessionID)
      return directory ? { location: { directory } } : undefined
    }

    const fetchFiles = async (sessionID: string): Promise<EditedFile[]> => {
      const family = context.data.session.family(sessionID)
      const sessionIDs = [...new Set([sessionID, rootOf(sessionID), ...family])]
      const result = await rpc.list({ sessionIDs }, rpcOptions(sessionID))
      return (result as { files: EditedFile[] }).files
    }

    /** Review marks live on the root session, so the whole family shares them. */
    const setReviewed = async (sessionID: string, files: EditedFile[], reviewed: boolean) => {
      if (files.length === 0) return
      try {
        await rpc.review(
          {
            sessionID: rootOf(sessionID),
            files: files.map((file) => ({ path: file.path, updated: file.updated })),
            reviewed,
          },
          rpcOptions(sessionID),
        )
      } catch {
        context.ui.toast.show({ title: "Edited files", message: "Could not update the review mark", variant: "error" })
      }
    }

    /** Reviews every unreviewed file in `files`; when none are left, clears all their marks instead. */
    const reviewAll = async (sessionID: string, files: EditedFile[]) => {
      const pending = files.filter((file) => !file.reviewed)
      const marking = pending.length > 0
      const targets = marking ? pending : files
      if (targets.length === 0) return
      await setReviewed(sessionID, targets, marking)
      context.ui.toast.show({
        title: "Edited files",
        message: `${marking ? "Marked" : "Unmarked"} ${targets.length} file${targets.length === 1 ? "" : "s"} as reviewed`,
      })
    }
    const reviewAllLabel = (files: EditedFile[]) => {
      if (!files.some((file) => !file.reviewed)) return "Unmark all"
      return files.some((file) => file.reviewed) ? "Mark all" : "Mark all as reviewed"
    }

    /** Files that belong to the current view (whole session, or only the last turn). */
    const inView = (files: EditedFile[], sessionID: string) => {
      if (prefs.baseline !== "turn") return files
      const start = lastTurnStart(sessionID)
      return files.filter((file) => file.updated >= start)
    }

    const withoutHiddenReviewed = (files: EditedFile[]) =>
      prefs.showReviewed ? files : files.filter((file) => !file.reviewed)

    const workspacePath = (file: EditedFile, sessionID: string) => {
      const base = sessionDirectory(sessionID)
      const relative = base ? path.relative(base, file.path) : ""
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined
    }

    const displayPath = (file: EditedFile, sessionID: string) => workspacePath(file, sessionID) ?? context.ui.format.path(file.path)

    /** Workspace files first, then the ones outside it; each keeps its order (newest first). */
    const workspaceFirst = (files: EditedFile[], sessionID: string) => {
      const inside = files.filter((file) => workspacePath(file, sessionID) !== undefined)
      return [...inside, ...files.filter((file) => !inside.includes(file))]
    }

    /** Groups by folder, workspace folders first, each in the order of first appearance. */
    const groupByDir = (files: EditedFile[], sessionID: string): Group[] => {
      const groups = new Map<string, Group>()
      for (const file of workspaceFirst(files, sessionID)) {
        const dir = path.dirname(displayPath(file, sessionID))
        let group = groups.get(dir)
        if (!group) groups.set(dir, (group = { dir, files: [], outside: workspacePath(file, sessionID) === undefined }))
        group.files.push(file)
      }
      return [...groups.values()]
    }

    const VIEWS: View[] = ["session", "turn", "review"]
    const setView = (view: View) =>
      setPrefs((draft) => {
        draft.baseline = view
      }).catch(() => {})
    const toggleView = () => setView(VIEWS[(VIEWS.indexOf(prefs.baseline) + 1) % VIEWS.length]!)
    const toggleShowReviewed = () =>
      setPrefs((draft) => {
        draft.showReviewed = !draft.showReviewed
      }).catch(() => {})

    const beforeOf = (file: EditedFile) =>
      prefs.baseline === "turn" ? file.turnBefore : prefs.baseline === "review" ? file.reviewBefore : file.sessionBefore

    const diffArgs = (file: EditedFile) => {
      const left = diffSide(beforeOf(file), file.path)
      const right = diffSide(file.after, file.path)
      return kind === "cli" ? [...editorCommand.slice(1), "--diff", left, right] : vimDiffArgs(editorCommand, left, right)
    }

    /** code/cursor tabs or gvim windows: started detached, all at once. */
    const spawnDiffs = (files: EditedFile[]) => {
      let failed = 0
      let done = 0
      for (const file of files) {
        const settle = (ok: boolean) => {
          if (!ok) failed++
          if (++done === files.length && failed > 0) {
            context.ui.toast.show({
              title: "Edited files",
              message: `Could not open ${failed} of ${files.length} diff(s) with \`${editor}\``,
              variant: "error",
            })
          }
        }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(editorCommand[0]!, diffArgs(file), { stdio: "ignore", detached: true })
        } catch {
          settle(false)
          continue
        }
        child.once("error", () => settle(false))
        child.once("exit", (code) => settle(code === 0))
        child.unref()
      }
    }

    /**
     * vim in this terminal: the TUI is suspended and the diffs open one after another; `:qa` goes to the next file,
     * `:cq` skips the rest. The TUI comes back when the last one closes.
     */
    const runTerminalDiffs = async (files: EditedFile[]) => {
      if (inTerminalEditor) return
      inTerminalEditor = true
      let error: string | undefined
      await context.renderer.suspend()
      try {
        for (const file of files) {
          const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(editorCommand[0]!, diffArgs(file), { stdio: "inherit", cwd: path.dirname(file.path) })
            child.once("error", reject)
            child.once("exit", (exitCode) => resolve(exitCode))
          }).catch((err: Error) => {
            error = `Could not start \`${editor}\`: ${err.message}`
            return -1
          })
          if (code !== 0) break
        }
      } finally {
        await context.renderer.resume()
        inTerminalEditor = false
        setEditorClosed((n) => n + 1)
      }
      if (error) context.ui.toast.show({ title: "Edited files", message: error, variant: "error" })
    }

    const openDiffs = async (files: EditedFile[]) => {
      if (files.length === 0) return
      if (kind === "cli" && !inVSCode) {
        context.ui.toast.show({
          title: "Edited files",
          message: `\`${editor} --diff\` needs the VS Code integrated terminal. Set OPENCODE_DIFF_EDITOR to vimdiff or gvimdiff to diff here.`,
          variant: "warning",
        })
        return
      }
      if (kind === "gui" && !process.env.DISPLAY) {
        context.ui.toast.show({
          title: "Edited files",
          message: `\`${editor}\` needs $DISPLAY (an X session). Set OPENCODE_DIFF_EDITOR to vimdiff to diff in this terminal.`,
          variant: "warning",
        })
        return
      }
      if (files.length > CONFIRM_OPEN_ABOVE) {
        const confirmed = await context.ui.dialog.confirm({
          title: "Open all diffs?",
          message:
            kind === "terminal"
              ? `This opens ${files.length} diffs in ${editorCommand[0]}, one after another (:qa for the next, :cq to stop).`
              : kind === "gui"
                ? `This opens ${files.length} ${editorCommand[0]} windows.`
                : `This opens ${files.length} diff tabs in ${editorCommand[0]}.`,
          label: { confirm: `Open ${files.length}`, cancel: "Cancel" },
        })
        if (!confirmed) return
      }
      if (kind === "terminal") await runTerminalDiffs(files)
      else spawnDiffs(files)
    }

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const showPicker = async () => {
      const sessionID = currentSessionID()
      if (!sessionID) return
      const all = inView(await fetchFiles(sessionID).catch(() => [] as EditedFile[]), sessionID)
      const files = withoutHiddenReviewed(all)
      if (files.length === 0) {
        context.ui.toast.show({
          title: "Edited files",
          message:
            all.length > 0
              ? prefs.baseline === "review"
                ? "No changes since review. Use /edits-reviewed to show reviewed files."
                : "All files are reviewed. Use /edits-reviewed to show them."
              : prefs.baseline === "turn"
                ? "No files edited in the last turn."
                : "No files edited in this session yet.",
        })
        return
      }
      const picked = await context.ui.dialog.select({
        title: `Edited files · ${viewLabel()}`,
        options: groupByDir(files, sessionID).flatMap((group) =>
          group.files.map((file) => ({
            title: `${file.reviewed ? "✓" : STATUS_MARK[file.status]} ${path.basename(file.path)}`,
            value: file.path,
            category: group.outside ? `Outside workspace · ${group.dir}` : group.dir === "." ? "./" : group.dir,
            description:
              (file.binary ? "binary" : `+${countsOf(file).add} -${countsOf(file).del}`) +
              (file.reviewed ? " · reviewed" : ""),
          })),
        ),
        actions: [
          { bind: "ctrl+a", title: "Open all", selection: "none", onTrigger: () => void openDiffs(files) },
          {
            bind: "ctrl+r",
            title: "Mark reviewed",
            onTrigger: async (value: unknown) => {
              const file = files.find((f) => f.path === value)
              if (!file) return
              await setReviewed(sessionID, [file], !file.reviewed)
              context.ui.dialog.clear()
              void showPicker()
            },
          },
          {
            bind: "ctrl+e",
            title: all.some((file) => !file.reviewed) ? "Mark all reviewed" : "Unmark all",
            selection: "none",
            onTrigger: async () => {
              await reviewAll(sessionID, all)
              context.ui.dialog.clear()
              void showPicker()
            },
          },
          {
            bind: "ctrl+t",
            title: "Switch view",
            selection: "none",
            onTrigger: async () => {
              await toggleView()
              context.ui.dialog.clear()
              void showPicker()
            },
          },
        ],
      })
      const file = files.find((f) => f.path === picked)
      if (file) void openDiffs([file])
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "edited-files.list",
          title: "Edited files: open diff",
          group: "Edited files",
          palette: true,
          slash: { name: "edits" },
          enabled: () => currentSessionID() !== undefined,
          run: () => void showPicker(),
        },
        {
          id: "edited-files.view",
          title: "Edited files: switch view (whole session / last turn / since review)",
          group: "Edited files",
          palette: true,
          slash: { name: "edits-view" },
          run: () => void toggleView(),
        },
        {
          id: "edited-files.reviewed",
          title: "Edited files: show/hide reviewed files",
          group: "Edited files",
          palette: true,
          slash: { name: "edits-reviewed" },
          run: () => void toggleShowReviewed(),
        },
        {
          id: "edited-files.review-all",
          title: "Edited files: mark all files in the current view as reviewed (or unmark them)",
          group: "Edited files",
          palette: true,
          slash: { name: "edits-review-all" },
          enabled: () => currentSessionID() !== undefined,
          run: () => {
            const sessionID = currentSessionID()
            if (!sessionID) return
            void fetchFiles(sessionID)
              .then((files) => reviewAll(sessionID, inView(files, sessionID)))
              .catch(() => {})
          },
        },
      ],
    }))

    function Clickable(props: { onClick: () => void; children: any }) {
      return (
        <box
          flexDirection="row"
          onMouseDown={(event: { stopPropagation(): void }) => {
            event.stopPropagation()
            props.onClick()
          }}
        >
          {props.children}
        </box>
      )
    }

    function FileRow(props: { file: EditedFile; sessionID: string }) {
      const [hover, setHover] = createSignal(false)
      const [markHover, setMarkHover] = createSignal(false)
      const stats = () => (props.file.binary ? " bin" : ` +${countsOf(props.file).add} -${countsOf(props.file).del}`)
      const label = () => truncateLeft(path.basename(props.file.path), SIDEBAR_WIDTH - 8 - stats().length)
      const dim = () => props.file.reviewed
      return (
        <box
          flexDirection="row"
          paddingLeft={2}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={(event: { stopPropagation(): void }) => {
            event.stopPropagation()
            void openDiffs([props.file])
          }}
        >
          <box
            onMouseOver={() => setMarkHover(true)}
            onMouseOut={() => setMarkHover(false)}
            onMouseUp={(event: { stopPropagation(): void }) => {
              event.stopPropagation()
              void setReviewed(props.sessionID, [props.file], !props.file.reviewed)
            }}
          >
            <text fg={markHover() ? color.accent() : props.file.reviewed ? color.added() : color.muted()}>
              {props.file.reviewed ? "✓ " : "○ "}
            </text>
          </box>
          <text fg={dim() ? color.muted() : statusColor(props.file)}>{`${STATUS_MARK[props.file.status]} `}</text>
          <text fg={hover() && !markHover() ? color.accent() : dim() ? color.muted() : color.header()}>{label()}</text>
          <Show when={!props.file.binary && !dim()} fallback={<text fg={color.muted()}>{stats()}</text>}>
            <text fg={color.added()}>{` +${countsOf(props.file).add}`}</text>
            <text fg={color.removed()}>{` -${countsOf(props.file).del}`}</text>
          </Show>
        </box>
      )
    }

    function EditedFilesSection(props: { sessionID: string }) {
      const [files, setFiles] = createSignal<EditedFile[]>([])
      let seq = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      const refresh = () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const mine = ++seq
          try {
            const next = await fetchFiles(props.sessionID)
            if (mine === seq) setFiles(next)
          } catch {
            // Keep the last list if the server is briefly unavailable.
          }
        }, 150)
      }

      createEffect(
        on(
          () => props.sessionID,
          () => {
            setFiles([])
            refresh()
          },
        ),
      )
      // Edits made outside OpenCode send no event, so re-check while any file is marked reviewed.
      createEffect(() => {
        if (!files().some((file) => file.reviewed)) return
        const poll = setInterval(refresh, REVIEW_RECHECK_MS)
        onCleanup(() => clearInterval(poll))
      })
      createEffect(on(editorClosed, () => refresh(), { defer: true }))
      const stopChanged = rpc.events.on("changed", () => refresh())
      const stopTurn = context.data.on("session.execution.succeeded", () => refresh())
      const stopRevert = context.data.on("session.revert.committed", () => refresh())
      onCleanup(() => {
        clearTimeout(timer)
        stopChanged()
        stopTurn()
        stopRevert()
      })

      const inViewFiles = createMemo(() => inView(files(), props.sessionID))
      const reviewedCount = () => inViewFiles().filter((file) => file.reviewed).length
      const scoped = createMemo(() => withoutHiddenReviewed(inViewFiles()))
      const sum = (files: EditedFile[]) =>
        files.reduce((acc, f) => ({ add: acc.add + countsOf(f).add, del: acc.del + countsOf(f).del }), { add: 0, del: 0 })
      const totals = () => sum(scoped())
      // The Workspace and Outside workspace headings show only when some files are outside; each can be collapsed.
      const outsideFiles = createMemo(() => scoped().filter((file) => workspacePath(file, props.sessionID) === undefined))
      const split = () => outsideFiles().length > 0
      const kindOf = (outside: boolean) => (outside ? "outside" : "workspace")
      const isCollapsed = (outside: boolean) => split() && !!prefs.collapsed?.[kindOf(outside)]
      const toggleKind = (outside: boolean) =>
        updatePrefs((d) => void (d.collapsed = { ...d.collapsed, [kindOf(outside)]: !d.collapsed?.[kindOf(outside)] }))
      const kindFiles = (outside: boolean) => (outside ? outsideFiles() : scoped().filter((file) => !outsideFiles().includes(file)))
      // Rows go to workspace files first; collapsed files take none.
      const shown = createMemo(() => workspaceFirst(scoped(), props.sessionID).filter((file) => !isCollapsed(workspacePath(file, props.sessionID) === undefined)))
      const visible = createMemo(() => (prefs.showAll ? shown() : shown().slice(0, COMPACT_ROWS)))
      const groups = createMemo(() => groupByDir(visible(), props.sessionID))
      const kinds = () => (split() ? [false, true] : [undefined])
      const hiddenOutside = () => outsideFiles().filter((file) => shown().includes(file) && !visible().includes(file)).length

      return (
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <Clickable onClick={() => updatePrefs((d) => void (d.expanded = !d.expanded))}>
            <text fg={color.header()}>{`${prefs.expanded ? "▼" : "▶"} Edited Files `}</text>
            <Show
              when={files().length > 0}
              fallback={<text fg={color.muted()}>{"· none yet"}</text>}
            >
              <text fg={color.muted()}>{`${scoped().length} `}</text>
              <text fg={color.added()}>{`+${totals().add} `}</text>
              <text fg={color.removed()}>{`-${totals().del}`}</text>
            </Show>
          </Clickable>
          <Show when={prefs.expanded && files().length > 0}>
            <box flexDirection="row">
              <For each={VIEWS}>
                {(view, index) => (
                  <>
                    <Show when={index() > 0}>
                      <text fg={color.muted()}>{" | "}</text>
                    </Show>
                    <Clickable onClick={() => void setView(view)}>
                      <text fg={prefs.baseline === view ? color.accent() : color.muted()}>
                        {view === "session" ? "Session" : VIEW_LABELS[view]}
                      </text>
                    </Clickable>
                  </>
                )}
              </For>
            </box>
            <Show when={inViewFiles().length > 0}>
              <box flexDirection="row">
                <Show when={reviewedCount() > 0}>
                  <text fg={color.added()}>{"✓ "}</text>
                  <text fg={color.muted()}>{`${reviewedCount()} reviewed · `}</text>
                  <Clickable onClick={() => void toggleShowReviewed()}>
                    <text fg={color.accent()}>{prefs.showReviewed ? "Hide" : "Show"}</text>
                  </Clickable>
                  <text fg={color.muted()}>{" · "}</text>
                </Show>
                <Clickable onClick={() => void reviewAll(props.sessionID, inViewFiles())}>
                  <text fg={color.accent()}>{reviewAllLabel(inViewFiles())}</text>
                </Clickable>
              </box>
            </Show>
            <Show when={scoped().length === 0}>
              <text fg={color.muted()}>
                {inViewFiles().length === 0
                  ? "  No files edited in the last turn"
                  : prefs.baseline === "review"
                    ? "  No changes since review"
                    : "  All files reviewed"}
              </text>
            </Show>
            <For each={kinds()}>
              {(outside) => (
                <box flexDirection="column">
                  <Show when={outside !== undefined}>
                    <Clickable onClick={() => toggleKind(!!outside)}>
                      <text fg={color.header()}>{`${isCollapsed(!!outside) ? "▶" : "▼"} ${outside ? "Outside workspace" : "Workspace"} `}</text>
                      <text fg={color.muted()}>{`${kindFiles(!!outside).length} `}</text>
                      <text fg={color.added()}>{`+${sum(kindFiles(!!outside)).add} `}</text>
                      <text fg={color.removed()}>{`-${sum(kindFiles(!!outside)).del}`}</text>
                    </Clickable>
                  </Show>
                  <For each={groups().filter((group) => outside === undefined || group.outside === outside)}>
                    {(group) => (
                      <box flexDirection="column">
                        <text fg={color.muted()}>
                          {truncateLeft(group.dir === "." ? "./" : `${group.dir}/`, SIDEBAR_WIDTH - 2)}
                        </text>
                        <For each={group.files}>{(file) => <FileRow file={file} sessionID={props.sessionID} />}</For>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
            <Show when={shown().length > COMPACT_ROWS}>
              <Clickable onClick={() => updatePrefs((d) => void (d.showAll = !d.showAll))}>
                <text fg={color.accent()}>
                  {prefs.showAll ? "▲ Show less" : `▼ Show all (${shown().length - COMPACT_ROWS} more${hiddenOutside() ? `, ${hiddenOutside()} outside workspace` : ""})`}
                </text>
              </Clickable>
            </Show>
          </Show>
        </box>
      )
    }

    const render = (input: { sessionID: string }) => <EditedFilesSection sessionID={input.sessionID} />
    // Built-in sections (Context, Limit, MCP, Todo) are appended first, so "top" is the only way above MCP.
    return (context.options as { position?: unknown } | undefined)?.position === "bottom"
      ? context.ui.slot({ append: "sidebar.content", render })
      : context.ui.slot({ prepend: "sidebar.content", render })
  },
})
