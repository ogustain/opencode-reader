import { Rpc } from "@opencode/plugin/rpc"
import type { AdbState, BooxBook } from "./adb.ts"
import type { BookIndex } from "./library.ts"
import type { OnyxState } from "./onyx.ts"
import type { Action, CloudBook, CloudCollection } from "./sync.ts"
import type { Paragraph } from "./text.ts"

/** A readable book on the server's disk (local folder or Boox cache). */
export type BookEntry = {
  key: string
  path: string
  title: string
  author?: string
  source: "local" | "boox"
  booxPath?: string
}

export type LibraryResult = { dir: string; books: BookEntry[] }
export type BooxListing = {
  state: AdbState
  message: string
  /** Epoch ms of the last successful listing. */
  checkedAt?: number
  books: Array<BooxBook & { key: string; cached?: string }>
}
/** `source`: where the file came from; `notHere`: neither the cloud nor ADB has it; `expired`: the cloud refused the token. */
export type FetchResult =
  | { ok: true; book: BookEntry; source: "cache" | "cloud" | "adb"; expired?: true }
  | { ok: false; error: string; notHere?: true; expired?: true }
export type OpenResult = ({ ok: true } & BookIndex) | { ok: false; error: string }
export type ChapterResult = { ok: true; paragraphs: Paragraph[] } | { ok: false; error: string }

export type SyncSettings = { cloud: boolean; pushIdleMinutes: number }
/** The Onyx cloud library (last known when `state` is not "ok"). */
export type CloudListing = {
  state: OnyxState
  message: string
  checkedAt?: number
  collections: CloudCollection[]
  books: Array<CloudBook & { key: string; cached?: string }>
}
/** A book's cloud position in the plugin's terms (no spine when the cloud has no reflow position). */
export type CloudPosition = {
  spine?: number
  offset?: number
  /** False when the position was estimated (unknown node). */
  exact?: boolean
  /** The Boox's page-based percentage. */
  percent?: number
  /** The Boox's last save (its own clock: for display only) and opening. */
  updateTime: number
  lastAccess: number
  /** What to do with the local reading (`reconcile`). */
  action: Action
  /** The cloud doc's revision and reading (`readingPrint`), sent back with `agree` once applied. */
  rev: string
  print: string
  /** Local page-turn time of the last agreement: settles a due push up to it. */
  agreedAt?: number
  /** The cloud has a reading position, but in no chapter of this copy. */
  unmapped?: true
}
export type PullResult = { ok: true; cloud: CloudPosition } | { ok: false; state: OnyxState; error: string }
export type PushResult =
  | { ok: true; pushed: true; at: number; agreedAt: number }
  /** Not sent: `action` says why (`reconcile`; "ask" when a forced push meets another revision). */
  | { ok: true; pushed: false; action: Action; agreedAt?: number }
  | { ok: false; state: OnyxState; error: string }

const object = { type: "object" } as const

export const ReaderRpc = Rpc.define({
  id: "opencode-reader",
  methods: {
    /** {} → LibraryResult */
    library: { input: object, output: object },
    /** { refresh?: boolean } → BooxListing (the device is asked at most once a minute) */
    boox: { input: object, output: object },
    /** { booxPath, size, cloud?: false } → FetchResult (cache, else the Onyx cloud file unless `cloud: false`, else ADB) */
    fetch: { input: object, output: object },
    /** { path } → OpenResult */
    open: { input: object, output: object },
    /** { path, spine } → ChapterResult */
    chapter: { input: object, output: object },
    /** {} → SyncSettings */
    settings: { input: object, output: object },
    /** { refresh?: boolean } → CloudListing (the cloud is asked at most once a minute) */
    cloud: { input: object, output: object },
    /** { path, booxPath, spine, offset, percent, finished, turnedAt } → PullResult (the local reading, `turnedAt`: its page-turn time) */
    pull: { input: object, output: object },
    /** { booxPath, rev, print, turnedAt } → { ok } (the cloud reading `print` at `rev` was applied locally at `turnedAt`) */
    agree: { input: object, output: object },
    /** { path, booxPath, spine, offset, percent, finished, turnedAt, force? } → PushResult (GET, then PUT of the book doc; `force`: the `_rev` the reader chose over) */
    push: { input: object, output: object },
  },
  events: {},
})
