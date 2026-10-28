import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { EditedFiles, type EditedFile } from "./rpc.ts"

/** "session": every edited file vs session start. "turn": only the last turn's files vs before that turn. */
type View = "session" | "turn"

interface Prefs {
  expanded: boolean
  baseline: View
  showAll?: boolean
}

interface Group {
  dir: string
  files: EditedFile[]
}

const SIDEBAR_WIDTH = 38
const COMPACT_ROWS = 10
const CONFIRM_OPEN_ABOVE = 10
const STATUS_MARK: Record<EditedFile["status"], string> = { added: "A", modified: "M", deleted: "D" }

/** Editor CLI that supports `--diff <left> <right>`: plugin option `editor`, then $OPENCODE_DIFF_EDITOR, then `code`. */
const resolveEditor = (options: Readonly<Record<string, unknown>> | undefined): string => {
  const fromOptions = options?.editor
  if (typeof fromOptions === "string" && fromOptions.trim()) return fromOptions.trim()
  const fromEnv = process.env.OPENCODE_DIFF_EDITOR
  if (fromEnv?.trim()) return fromEnv.trim()
  return "code"
}

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
    const inVSCode = !!process.env.VSCODE_IPC_HOOK_CLI
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
        : { add: file.additions, del: file.deletions }

    const viewLabel = () => (prefs.baseline === "turn" ? "last turn" : "whole session")

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

    const fetchFiles = async (sessionID: string): Promise<EditedFile[]> => {
      const family = context.data.session.family(sessionID)
      const sessionIDs = [...new Set([sessionID, ...family])]
      const directory = sessionDirectory(sessionID)
      const result = await rpc.list({ sessionIDs }, directory ? { location: { directory } } : undefined)
      return (result as { files: EditedFile[] }).files
    }

    const applyScope = (files: EditedFile[], sessionID: string) => {
      if (prefs.baseline !== "turn") return files
      const start = lastTurnStart(sessionID)
      return files.filter((file) => file.updated >= start)
    }

    const displayPath = (file: EditedFile, sessionID: string) => {
      const base = sessionDirectory(sessionID)
      const relative = base ? path.relative(base, file.path) : ""
      return relative && !relative.startsWith("..") ? relative : context.ui.format.path(file.path)
    }

    /** Groups by folder, keeping the order of first appearance (files arrive newest first). */
    const groupByDir = (files: EditedFile[], sessionID: string): Group[] => {
      const groups = new Map<string, Group>()
      for (const file of files) {
        const dir = path.dirname(displayPath(file, sessionID))
        let group = groups.get(dir)
        if (!group) groups.set(dir, (group = { dir, files: [] }))
        group.files.push(file)
      }
      return [...groups.values()]
    }

    const toggleView = () =>
      setPrefs((draft) => {
        draft.baseline = draft.baseline === "session" ? "turn" : "session"
      }).catch(() => {})

    const spawnDiffs = (files: EditedFile[]) => {
      let failed = 0
      let done = 0
      for (const file of files) {
        const settle = (ok: boolean) => {
          if (!ok) failed++
          if (++done === files.length && failed > 0) {
            context.ui.toast.show({
              title: "Edited files",
              message: `Could not open ${failed} of ${files.length} diff(s) with \`${editor} --diff\``,
              variant: "error",
            })
          }
        }
        const before = prefs.baseline === "turn" ? file.turnBefore : file.sessionBefore
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(editor, ["--diff", diffSide(before, file.path), diffSide(file.after, file.path)], {
            stdio: "ignore",
            detached: true,
          })
        } catch {
          settle(false)
          continue
        }
        child.once("error", () => settle(false))
        child.once("exit", (code) => settle(code === 0))
        child.unref()
      }
    }

    const openDiffs = async (files: EditedFile[]) => {
      if (files.length === 0) return
      if (!inVSCode) {
        context.ui.toast.show({
          title: "Edited files",
          message: "Diffs open in VS Code: start opencode from the VS Code integrated terminal.",
          variant: "warning",
        })
        return
      }
      if (files.length > CONFIRM_OPEN_ABOVE) {
        const confirmed = await context.ui.dialog.confirm({
          title: "Open all diffs?",
          message: `This opens ${files.length} diff tabs in VS Code.`,
          label: { confirm: `Open ${files.length}`, cancel: "Cancel" },
        })
        if (!confirmed) return
      }
      spawnDiffs(files)
    }

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const showPicker = async () => {
      const sessionID = currentSessionID()
      if (!sessionID) return
      const files = applyScope(await fetchFiles(sessionID).catch(() => [] as EditedFile[]), sessionID)
      if (files.length === 0) {
        context.ui.toast.show({
          title: "Edited files",
          message: prefs.baseline === "turn" ? "No files edited in the last turn." : "No files edited in this session yet.",
        })
        return
      }
      const picked = await context.ui.dialog.select({
        title: `Edited files · ${viewLabel()}`,
        options: groupByDir(files, sessionID).flatMap((group) =>
          group.files.map((file) => ({
            title: `${STATUS_MARK[file.status]} ${path.basename(file.path)}`,
            value: file.path,
            category: group.dir === "." ? "./" : group.dir,
            description: file.binary ? "binary" : `+${countsOf(file).add} -${countsOf(file).del}`,
          })),
        ),
        actions: [
          { bind: "ctrl+a", title: "Open all", selection: "none", onTrigger: () => void openDiffs(files) },
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
          title: "Edited files: switch view (whole session / last turn)",
          group: "Edited files",
          palette: true,
          slash: { name: "edits-view" },
          run: () => void toggleView(),
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
      const stats = () => (props.file.binary ? " bin" : ` +${countsOf(props.file).add} -${countsOf(props.file).del}`)
      const label = () => truncateLeft(path.basename(props.file.path), SIDEBAR_WIDTH - 6 - stats().length)
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
          <text fg={statusColor(props.file)}>{`${STATUS_MARK[props.file.status]} `}</text>
          <text fg={hover() ? color.accent() : color.header()}>{label()}</text>
          <Show when={!props.file.binary} fallback={<text fg={color.muted()}>{stats()}</text>}>
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
      const stopChanged = rpc.events.on("changed", () => refresh())
      const stopTurn = context.data.on("session.execution.succeeded", () => refresh())
      const stopRevert = context.data.on("session.revert.committed", () => refresh())
      onCleanup(() => {
        clearTimeout(timer)
        stopChanged()
        stopTurn()
        stopRevert()
      })

      const scoped = createMemo(() => applyScope(files(), props.sessionID))
      const visible = createMemo(() => (prefs.showAll ? scoped() : scoped().slice(0, COMPACT_ROWS)))
      const groups = createMemo(() => groupByDir(visible(), props.sessionID))
      const totals = () =>
        scoped().reduce(
          (acc, f) => ({ add: acc.add + countsOf(f).add, del: acc.del + countsOf(f).del }),
          { add: 0, del: 0 },
        )

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
            <Clickable onClick={() => void toggleView()}>
              <text fg={color.muted()}>{"view: "}</text>
              <text fg={prefs.baseline === "session" ? color.accent() : color.muted()}>{"whole session"}</text>
              <text fg={color.muted()}>{" | "}</text>
              <text fg={prefs.baseline === "turn" ? color.accent() : color.muted()}>{"last turn"}</text>
            </Clickable>
            <Show when={scoped().length === 0}>
              <text fg={color.muted()}>{"  no files edited in the last turn"}</text>
            </Show>
            <For each={groups()}>
              {(group) => (
                <box flexDirection="column">
                  <text fg={color.muted()}>
                    {truncateLeft(group.dir === "." ? "./" : `${group.dir}/`, SIDEBAR_WIDTH - 2)}
                  </text>
                  <For each={group.files}>{(file) => <FileRow file={file} sessionID={props.sessionID} />}</For>
                </box>
              )}
            </For>
            <Show when={scoped().length > COMPACT_ROWS}>
              <Clickable onClick={() => updatePrefs((d) => void (d.showAll = !d.showAll))}>
                <text fg={color.accent()}>
                  {prefs.showAll ? "▲ show less" : `▼ show all (${scoped().length - COMPACT_ROWS} more)`}
                </text>
              </Clickable>
            </Show>
          </Show>
        </box>
      )
    }

    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <EditedFilesSection sessionID={input.sessionID} />,
    })
  },
})
