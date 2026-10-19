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
  lastAccess: number
  /** What to do with the local reading (`reconcile`). */
  action: Action
  /** The cloud reading (`readingPrint`), sent back with `agree` once applied. */
  print: string
  /** The cloud has a reading position, but in no chapter of this copy. */
  unmapped?: true
}
export type PullResult = { ok: true; cloud: CloudPosition } | { ok: false; state: OnyxState; error: string }
export type PushResult =
  | { ok: true; pushed: true; at: number }
  /** `pull`: the cloud's reading is the one to take (`reconcile`). */
  | { ok: true; pushed: false; reason: string; pull?: true }
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
    /** { path, booxPath, gen, turnedAt, receipt? } → PullResult (the local reading's generation, page-turn time, last push receipt) */
    pull: { input: object, output: object },
    /** { booxPath, print, gen } → { ok } (the cloud reading `print` was applied locally as generation `gen`) */
    agree: { input: object, output: object },
    /** { path, booxPath, spine, offset, percent, finished, gen, turnedAt, receipt? } → PushResult (GET, then PUT of the book doc) */
    push: { input: object, output: object },
  },
  events: {},
})
