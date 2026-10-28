import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { EditedFiles, type EditedFile, type ReviewInput } from "./rpc.ts"

const NULL_DEVICE = "/dev/null"
const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const TURN_END_EVENTS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]

interface Target {
  from: string
  to: string
}

interface Tracked {
  path: string
  sessionBefore: string
  turnBefore: string
  turn: number
  firstEdited: number
  updated: number
  edits: number
}

interface SessionState {
  turn: number
  files: Map<string, Tracked>
  reviewed: Map<string, ReviewMark>
}

/** A file counts as reviewed while it has no newer tracked edit and its content still matches. */
interface ReviewMark {
  /** The file's `updated` value that was reviewed. */
  updated: number
  /** SHA-256 of the content when it was marked, or "gone" for a deleted file. */
  hash: string
  /** Copy of the file when it was marked: the baseline for the "since review" view. */
  snapshot?: string
  /** Set once the file changed after being marked; the mark stays only as a diff baseline. */
  stale?: boolean
}

/** Snapshot decision made before a tool runs; applied once it succeeds. */
interface Planned extends Target {
  /** Backup (or /dev/null) for a file the session has not touched yet. */
  first?: string
  /** Backup for a tracked file's first edit in the current turn. */
  turn?: string
}

interface PendingCall {
  sessionID: string
  planned: Planned[]
}

interface Stats {
  key: string
  additions: number
  deletions: number
  binary: boolean
}

const fileInfo = async (file: string) => {
  try {
    const info = await stat(file)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

const isSessionNotFound = (error: unknown) => {
  const tagged = error as { _tag?: unknown; name?: unknown; message?: unknown } | null
  return [tagged?._tag, tagged?.name, tagged?.message].some(
    (value) => typeof value === "string" && /SessionNotFound|Session not found/.test(value),
  )
}

const removeQuietly = (target: string) => rm(target, { recursive: true, force: true }).catch(() => {})

const parsePatchTargets = (patchText: string): Target[] => {
  const targets: Target[] = []
  for (const raw of patchText.split("\n")) {
    const line = raw.replace(/\r$/, "")
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      const file = header[2].trim()
      targets.push({ from: file, to: file })
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const last = targets.at(-1)
    if (move && last) last.to = move[1].trim()
  }
  return targets
}

const collectTargets = (tool: string, input: unknown, directory: string): Target[] => {
  const args = (input ?? {}) as Record<string, unknown>
  const resolve = (file: string) => path.resolve(directory, file)

  if (tool === "patch") {
    const patchText = args.patchText
    if (typeof patchText !== "string") return []
    return parsePatchTargets(patchText).map(({ from, to }) => ({ from: resolve(from), to: resolve(to) }))
  }

  const file = args.path ?? args.filePath ?? args.file_path
  if (typeof file !== "string" || !file) return []
  return [{ from: resolve(file), to: resolve(file) }]
}

/** Line counts between two files using the system `diff` (normal output format). */
const countLines = (before: string, after: string) =>
  new Promise<Omit<Stats, "key">>((resolve) => {
    execFile("diff", ["--", before, after], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code
      if (error && code !== 1) return resolve({ additions: 0, deletions: 0, binary: false })
      if (/^Binary files .* differ$/m.test(stdout)) return resolve({ additions: 0, deletions: 0, binary: true })
      let additions = 0
      let deletions = 0
      for (const line of stdout.split("\n")) {
        if (line.startsWith(">")) additions++
        else if (line.startsWith("<")) deletions++
      }
      resolve({ additions, deletions, binary: false })
    })
  })

export default Plugin.define({
  id: "edited-files",
  async setup(ctx) {
    const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state")
    const root = path.join(stateHome, "opencode-edited-files")
    const sessionsDir = path.join(root, "sessions")
    const backupsDir = path.join(root, "backups")
    const sessions = new Map<string, Promise<SessionState>>()
    const calls = new Map<string, PendingCall>()
    const sessionDirs = new Map<string, string>()
    const statsCache = new Map<string, Stats>()

    await mkdir(sessionsDir, { recursive: true, mode: 0o700 })
    await mkdir(backupsDir, { recursive: true, mode: 0o700 })
    void pruneStale()

    const stateFile = (sessionID: string) => path.join(sessionsDir, `${sessionID}.json`)
    const sessionBackups = (sessionID: string) => path.join(backupsDir, sessionID)

    const load = async (sessionID: string): Promise<SessionState> => {
      try {
        const raw = JSON.parse(await readFile(stateFile(sessionID), "utf8")) as {
          turn: number
          files: Tracked[]
          reviewed?: Record<string, ReviewMark>
        }
        const marks = Object.entries(raw.reviewed ?? {}).filter(
          (entry): entry is [string, ReviewMark] => typeof entry[1]?.hash === "string",
        )
        return {
          turn: raw.turn ?? 0,
          files: new Map(raw.files.map((file) => [file.path, file])),
          reviewed: new Map(marks),
        }
      } catch {
        return { turn: 0, files: new Map(), reviewed: new Map() }
      }
    }

    const stateOf = (sessionID: string) => {
      let state = sessions.get(sessionID)
      if (!state) sessions.set(sessionID, (state = load(sessionID)))
      return state
    }

    const save = async (sessionID: string, state: SessionState) => {
      const file = stateFile(sessionID)
      const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`
      try {
        const data = {
          turn: state.turn,
          files: [...state.files.values()],
          reviewed: Object.fromEntries(state.reviewed),
        }
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        void removeQuietly(temp)
        console.warn("[edited-files] could not save session state", error)
      }
    }

    const sessionDirectory = async (sessionID: string) => {
      const cached = sessionDirs.get(sessionID)
      if (cached) return cached
      let directory: string = ctx.location.directory
      try {
        const session = (await ctx.session.get({ sessionID })) as { location?: { directory?: string } }
        directory = session.location?.directory ?? directory
      } catch {
        // Fall back to the plugin location.
      }
      sessionDirs.set(sessionID, directory)
      return directory
    }

    const backup = async (sessionID: string, file: string) => {
      if (!(await fileInfo(file))) return NULL_DEVICE
      const dir = sessionBackups(sessionID)
      const target = path.join(dir, `${randomUUID().slice(0, 8)}-${path.basename(file)}`)
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await copyFile(file, target)
        return target
      } catch {
        return NULL_DEVICE
      }
    }

    const hashCache = new Map<string, { version: string; hash: string }>()
    const contentHash = async (file: string) => {
      const info = await fileInfo(file)
      if (!info) return "gone"
      const version = `${info.mtimeMs}:${info.size}`
      const cached = hashCache.get(file)
      if (cached?.version === version) return cached.hash
      try {
        const hash = createHash("sha256").update(await readFile(file)).digest("hex")
        hashCache.set(file, { version, hash })
        return hash
      } catch {
        return "unreadable"
      }
    }

    const discard = (file: string | undefined) => {
      if (file && file.startsWith(backupsDir + path.sep)) void removeQuietly(file)
    }

    const registration = await ctx.rpc.register(EditedFiles, {
      list: async (input) => {
        const { sessionIDs } = input as { sessionIDs: string[] }
        // Merge the family: earliest session baseline, latest turn baseline per path.
        const merged = new Map<string, Tracked>()
        const marks = new Map<string, { mark: ReviewMark; sessionID: string }>()
        for (const sessionID of sessionIDs) {
          const state = await stateOf(sessionID)
          for (const [file, mark] of state.reviewed) {
            const seen = marks.get(file)
            if (!seen || mark.updated > seen.mark.updated) marks.set(file, { mark, sessionID })
          }
          for (const file of state.files.values()) {
            const seen = merged.get(file.path)
            if (!seen) {
              merged.set(file.path, { ...file })
              continue
            }
            if (file.firstEdited < seen.firstEdited) {
              seen.sessionBefore = file.sessionBefore
              seen.firstEdited = file.firstEdited
            }
            if (file.updated > seen.updated) {
              seen.turnBefore = file.turnBefore
              seen.updated = file.updated
            }
            seen.edits += file.edits
          }
        }

        /** Checks a mark; once the file outgrows it, it is stale for good (kept only as a diff baseline). */
        const stale = new Set<string>()
        const isReviewed = async (file: Tracked) => {
          const entry = marks.get(file.path)
          if (!entry || entry.mark.stale) return false
          if (entry.mark.updated >= file.updated && entry.mark.hash === (await contentHash(file.path))) return true
          entry.mark.stale = true
          stale.add(entry.sessionID)
          return false
        }

        const files: EditedFile[] = []
        for (const file of merged.values()) {
          const info = await fileInfo(file.path)
          if (!info && file.sessionBefore === NULL_DEVICE) continue
          const after = info ? file.path : NULL_DEVICE
          const version = info ? `${info.mtimeMs}:${info.size}` : "gone"
          const statsFor = async (before: string) => {
            const key = `${before}|${version}`
            const cacheKey = `${file.path}|${before}`
            let cached = statsCache.get(cacheKey)
            if (cached?.key !== key) {
              cached = { key, ...(await countLines(before, after)) }
              statsCache.set(cacheKey, cached)
            }
            return cached
          }
          const reviewed = await isReviewed(file)
          const reviewBefore = marks.get(file.path)?.mark.snapshot ?? file.sessionBefore
          const stats = await statsFor(file.sessionBefore)
          const turnStats = file.turnBefore === file.sessionBefore ? stats : await statsFor(file.turnBefore)
          const reviewStats = reviewBefore === file.sessionBefore ? stats : await statsFor(reviewBefore)
          files.push({
            path: file.path,
            status: file.sessionBefore === NULL_DEVICE ? "added" : info ? "modified" : "deleted",
            sessionBefore: file.sessionBefore,
            turnBefore: file.turnBefore,
            after,
            additions: stats.additions,
            deletions: stats.deletions,
            turnAdditions: turnStats.additions,
            turnDeletions: turnStats.deletions,
            reviewBefore,
            reviewAdditions: reviewStats.additions,
            reviewDeletions: reviewStats.deletions,
            binary: stats.binary,
            edits: file.edits,
            updated: file.updated,
            reviewed,
          })
        }
        for (const sessionID of stale) await save(sessionID, await stateOf(sessionID))
        files.sort((a, b) => b.updated - a.updated)
        return { files }
      },
      review: async (input) => {
        const { sessionID, files, reviewed } = input as ReviewInput
        const state = await stateOf(sessionID)
        for (const { path: file, updated } of files) {
          discard(state.reviewed.get(file)?.snapshot)
          if (reviewed) {
            const snapshot = await backup(sessionID, file)
            state.reviewed.set(file, { updated, hash: await contentHash(file), snapshot })
          } else {
            state.reviewed.delete(file)
          }
        }
        await save(sessionID, state)
        await registration.events.emit("changed", { sessionID })
        return { ok: true }
      },
    })

    await ctx.tool.hook("execute.before", async (event) => {
      if (!EDIT_TOOLS.has(event.tool)) return
      const directory = await sessionDirectory(event.sessionID)
      const targets = collectTargets(event.tool, event.input, directory)
      if (targets.length === 0) return

      const state = await stateOf(event.sessionID)
      const planned: Planned[] = []
      for (const target of targets) {
        const tracked = state.files.get(target.from)
        if (!tracked) planned.push({ ...target, first: await backup(event.sessionID, target.from) })
        else if (tracked.turn !== state.turn) planned.push({ ...target, turn: await backup(event.sessionID, target.from) })
        else planned.push({ ...target })
      }
      calls.set(event.id, { sessionID: event.sessionID, planned })
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const call = calls.get(event.id)
      if (!call) return
      calls.delete(event.id)

      if (event.status === "error") {
        for (const plan of call.planned) {
          discard(plan.first)
          discard(plan.turn)
        }
        return
      }

      const state = await stateOf(call.sessionID)
      const now = Date.now()
      for (const plan of call.planned) {
        let tracked = state.files.get(plan.from)
        if (!tracked) {
          const before = plan.first ?? NULL_DEVICE
          tracked = { path: plan.from, sessionBefore: before, turnBefore: before, turn: state.turn, firstEdited: now, updated: now, edits: 0 }
        } else {
          // A parallel call may have tracked the file first; its snapshot wins.
          discard(plan.first)
          if (tracked.turn !== state.turn) {
            if (tracked.turnBefore !== tracked.sessionBefore) discard(tracked.turnBefore)
            tracked.turnBefore = plan.turn ?? tracked.turnBefore
            tracked.turn = state.turn
          } else {
            discard(plan.turn)
          }
        }
        tracked.edits++
        tracked.updated = now
        if (plan.from !== plan.to) {
          state.files.delete(plan.from)
          tracked.path = plan.to
        }
        state.files.set(plan.to, tracked)
      }
      await save(call.sessionID, state)
      await registration.events.emit("changed", { sessionID: call.sessionID })
    })

    const forget = async (sessionID: string) => {
      sessions.delete(sessionID)
      sessionDirs.delete(sessionID)
      await removeQuietly(stateFile(sessionID))
      await removeQuietly(sessionBackups(sessionID))
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [...TURN_END_EVENTS, "session.deleted"] as never,
          signal: controller.signal,
        })) {
          const { type, data } = event as unknown as { type: string; data: { sessionID: string } }
          if (type === "session.deleted") {
            await forget(data.sessionID)
            continue
          }
          const state = await stateOf(data.sessionID)
          if (state.files.size === 0) continue
          state.turn++
          await save(data.sessionID, state)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[edited-files] event stream ended", error)
      }
    })()

    // Drop state for sessions deleted while the service was not running.
    async function pruneStale() {
      try {
        for (const entry of await readdir(sessionsDir)) {
          if (!entry.endsWith(".json")) continue
          const sessionID = entry.slice(0, -".json".length)
          try {
            await ctx.session.get({ sessionID })
          } catch (error) {
            if (isSessionNotFound(error)) await forget(sessionID)
          }
        }
      } catch {
        // Nothing to prune.
      }
    }

    return () => controller.abort()
  },
})
