import { Rpc } from "@opencode/plugin/rpc"

const editedFile = {
  type: "object",
  properties: {
    path: { type: "string" },
    status: { type: "string", enum: ["added", "modified", "deleted"] },
    sessionBefore: { type: "string" },
    turnBefore: { type: "string" },
    after: { type: "string" },
    additions: { type: "number" },
    deletions: { type: "number" },
    turnAdditions: { type: "number" },
    turnDeletions: { type: "number" },
    binary: { type: "boolean" },
    edits: { type: "number" },
    updated: { type: "number" },
    reviewed: { type: "boolean" },
  },
  required: [
    "path",
    "status",
    "sessionBefore",
    "turnBefore",
    "after",
    "additions",
    "deletions",
    "turnAdditions",
    "turnDeletions",
    "binary",
    "edits",
    "updated",
    "reviewed",
  ],
  additionalProperties: false,
} as const

export const EditedFiles = Rpc.define({
  id: "edited-files",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionIDs: { type: "array", items: { type: "string" } } },
        required: ["sessionIDs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { files: { type: "array", items: editedFile } },
        required: ["files"],
        additionalProperties: false,
      },
    },
    review: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          path: { type: "string" },
          updated: { type: "number" },
          reviewed: { type: "boolean" },
        },
        required: ["sessionID", "path", "updated", "reviewed"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})

export interface EditedFile {
  /** Current location of the file (after renames). */
  path: string
  status: "added" | "modified" | "deleted"
  /** Snapshot from before the session first touched the file, or /dev/null when it did not exist. */
  sessionBefore: string
  /** Snapshot from before the latest turn that edited the file, or /dev/null. */
  turnBefore: string
  /** The file itself, or /dev/null when it was deleted. */
  after: string
  /** Line counts against `sessionBefore`. */
  additions: number
  deletions: number
  /** Line counts against `turnBefore`. */
  turnAdditions: number
  turnDeletions: number
  binary: boolean
  /** Number of successful edit tool calls on the file. */
  edits: number
  /** Last edit time (epoch ms). */
  updated: number
  /** Marked as reviewed, and not edited since. */
  reviewed: boolean
}

export interface ReviewInput {
  /** Session that stores the mark (the root of the family). */
  sessionID: string
  path: string
  /** The file's `updated` value the user reviewed; a later edit clears the mark. */
  updated: number
  reviewed: boolean
}
