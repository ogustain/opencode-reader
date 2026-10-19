import { Rpc } from "@opencode/plugin/rpc"
import type { AdbState, BooxBook } from "./adb.ts"
import type { BookIndex } from "./library.ts"
import type { OnyxState } from "./onyx.ts"
import type { CloudBook, CloudCollection, CloudSide, OwnPush } from "./sync.ts"
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
  updateTime: number
  lastAccess: number
  deviceModel?: string
  /** Whether the cloud holds one of our writes (the server's record of them). */
  side?: CloudSide
  /** The cloud has a reading position, but in no chapter of this copy. */
  unmapped?: true
}
export type PullResult = { ok: true; cloud: CloudPosition } | { ok: false; state: OnyxState; error: string }
export type PushResult =
  | { ok: true; pushed: true; at: number }
  /** `ack`: the cloud already holds our write of this reading (or a later one). */
  | { ok: true; pushed: false; reason: string; ack?: OwnPush }
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
    /** { path, booxPath, turnedAt? } → PullResult (`turnedAt`: page-turn time of the local reading, recorded with the revision seen) */
    pull: { input: object, output: object },
    /** { path, booxPath, spine, offset, percent, turnedAt, own?: OwnPush } → PushResult (GET, then PUT of the book doc) */
    push: { input: object, output: object },
  },
  events: {},
})
