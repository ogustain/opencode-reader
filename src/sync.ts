/**
 * Onyx cloud library docs: the collection tree, the reading position of a
 * book doc, the push/pull decisions and the patch of a book doc. Pure (no
 * I/O), shared by both halves.
 *
 * Doc kinds by `modeType`: 3 collection, 5 membership (book ↔ collection),
 * 4 book, 1 annotation, 7 note. `status: 1` marks a removed doc (seen on
 * memberships and annotations, each followed by a status-0 copy when the
 * user re-added it).
 */
import {
  formatNeoPosition, neoPoint, neoToOffset, offsetToNeo, parseNeoPosition, withNeoFields, type ChapterMap, type NeoPoint,
  type NeoPosition,
} from "./neoposition.ts"

type Doc = Record<string, unknown>

/** Said once when the token is refused (shared with the TUI, which cannot import `onyx.ts`). */
export const EXPIRED_MESSAGE = "Onyx token expired: paste a new one (see README)"

export type BatchFetch = { ok: boolean; notHere?: boolean; expired?: boolean }

/**
 * Fetches books one at a time. Once the token is refused the rest skip the
 * cloud (`cloud` false; ADB may still copy them), and `expired` says so once.
 */
export async function downloadBatch<B>(books: readonly B[], fetch: (book: B, cloud: boolean) => Promise<BatchFetch>) {
  let downloaded = 0
  let onBoox = 0
  let expired = false
  const failed: B[] = []
  for (const book of books) {
    const result = await fetch(book, !expired)
    if (result.expired) expired = true
    if (result.ok) downloaded++
    else if (result.notHere || result.expired) onBoox++
    else failed.push(book)
  }
  return { downloaded, onBoox, failed, expired }
}

export type CloudBook = {
  /** Doc `_id` (`<uid>#<uniqueId>`). */
  id: string
  title: string
  /** File path on the Boox. */
  path: string
  size: number
  current?: number
  total?: number
  /** 0–100 */
  percent?: number
  /** Epoch ms of the last read on the Boox, 0 when never opened. */
  lastAccess: number
  finished: boolean
  collections: string[]
  /** The Boox was asked to upload the file (`fileSyncStatus: 1`): a hint, the download is the truth. */
  uploaded?: boolean
}
export type CloudCollection = { id: string; name: string; parent?: string }
export type CloudLibrary = { collections: CloudCollection[]; books: CloudBook[] }

const str = (v: unknown) => (typeof v === "string" ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const live = (d: Doc) => d.status !== 1 && d._deleted !== true

export function parseProgress(value: unknown): { current: number; total: number } | undefined {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(typeof value === "string" ? value : "")
  if (!m || Number(m[2]) <= 0) return undefined
  return { current: Math.min(Number(m[1]), Number(m[2])), total: Number(m[2]) }
}

/**
 * The cached library after a push wrote `progress` to book `id`: its page
 * count and %, and finished at total/total, until the next library read.
 */
export function withPushedProgress(books: readonly CloudBook[], id: string, progress: unknown): CloudBook[] {
  const p = parseProgress(progress)
  if (!p) return [...books]
  return books.map((b) => (b.id === id ? { ...b, current: p.current, total: p.total, percent: (p.current / p.total) * 100, finished: p.current >= p.total } : b))
}

/** A book doc's page count: NeoReader's `total_page`, else the `progress` total. */
export function docTotal(doc: Doc): number | undefined {
  return num(backendOf(doc)?.total_page) || parseProgress(doc.progress)?.total
}

/** EPUB books, collections and memberships of the library channel. */
export function cloudLibrary(docs: readonly Doc[]): CloudLibrary {
  const memberOf = new Map<string, Set<string>>()
  for (const d of docs) {
    const book = str(d.documentUniqueId)
    const collection = str(d.libraryUniqueId)
    if (d.modeType !== 5 || !live(d) || !book || !collection) continue
    if (!memberOf.has(book)) memberOf.set(book, new Set())
    memberOf.get(book)!.add(collection)
  }
  const collections = docs
    .filter((d) => d.modeType === 3 && live(d) && str(d.uniqueId))
    .map((d): CloudCollection => ({ id: str(d.uniqueId)!, name: str(d.name) ?? "Untitled", ...(str(d.parentUniqueId) ? { parent: str(d.parentUniqueId) } : {}) }))
  const books = docs
    .filter((d) => d.modeType === 4 && live(d) && str(d._id) && str(d.uniqueId))
    .filter((d) => d.type === "epub" || /\.epub$/i.test(str(d.nativeAbsolutePath) ?? ""))
    .map((d): CloudBook => {
      const progress = parseProgress(d.progress)
      const name = str(d.name) ?? "Untitled"
      return {
        id: str(d._id)!,
        title: str(d.title) || name.replace(/\.epub$/i, ""),
        path: str(d.nativeAbsolutePath) ?? "",
        size: num(d.size) ?? 0,
        ...(progress ? { current: progress.current, total: progress.total, percent: (progress.current / progress.total) * 100 } : {}),
        lastAccess: num(d.lastAccess) ?? 0,
        finished: progress ? progress.current >= progress.total : d.readingStatus === 2,
        collections: [...(memberOf.get(str(d.uniqueId)!) ?? [])],
        ...(d.fileSyncStatus === 1 ? { uploaded: true } : {}),
      }
    })
  return { collections, books }
}

export type TreeNode = { id?: string; name: string; children: TreeNode[]; books: CloudBook[]; /** Books in the subtree. */ count: number }

/**
 * The collection tree the Boox shows. The root's `books` are the ones in no
 * collection; finished books are left out unless asked, and empty
 * collections with them. Most recently read first.
 */
export function libraryTree(library: CloudLibrary, options: { showFinished?: boolean } = {}): { root: TreeNode; finished: number } {
  const shown = library.books.filter((b) => options.showFinished || !b.finished)
  const known = new Map(library.collections.map((c) => [c.id, c]))
  const byRecent = (a: CloudBook, b: CloudBook) => b.lastAccess - a.lastAccess || a.title.localeCompare(b.title)
  const build = (parent: string | undefined, depth: number, seen: Set<string>): TreeNode[] =>
    library.collections
      .filter((c) => (parent === undefined ? !c.parent || !known.has(c.parent) : c.parent === parent) && !seen.has(c.id))
      .map((c) => {
        const children = depth < 8 ? build(c.id, depth + 1, new Set([...seen, c.id])) : []
        const books = shown.filter((b) => b.collections.includes(c.id)).sort(byRecent)
        return { id: c.id, name: c.name, children, books, count: books.length + children.reduce((n, child) => n + child.count, 0) }
      })
      .filter((node) => node.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  const children = build(undefined, 0, new Set())
  const loose = shown.filter((b) => !b.collections.some((id) => known.has(id))).sort(byRecent)
  return {
    root: { name: "Library", children, books: loose, count: loose.length + children.reduce((n, c) => n + c.count, 0) },
    finished: library.books.filter((b) => b.finished).length,
  }
}

// ---------------------------------------------------------------------------
// Reading position of a book doc

/** Position strings of `backend`, the first present one is read. */
export const POSITION_KEYS = ["current_page_position_v3", "current_page_position_v2", "current_page"] as const

export type CloudReading = {
  point?: NeoPoint
  /** `backend.user_doc_data_update_time`: when a device last saved the position. */
  updateTime: number
  lastAccess: number
  deviceModel?: string
  totalPage?: number
}

export function backendOf(doc: Doc): Record<string, unknown> | undefined {
  try {
    const extra = JSON.parse(String(doc.extraAttributes)) as { backend?: unknown }
    return extra?.backend && typeof extra.backend === "object" ? (extra.backend as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function cloudReading(doc: Doc): CloudReading {
  const backend = backendOf(doc) ?? {}
  const position = POSITION_KEYS.map((key) => neoPoint(parseNeoPosition(backend[key]))).find(Boolean)
  return {
    ...(position ? { point: position } : {}),
    updateTime: num(backend.user_doc_data_update_time) ?? 0,
    lastAccess: num(doc.lastAccess) ?? 0,
    ...(str(backend.device_model) ? { deviceModel: str(backend.device_model) } : {}),
    ...(num(backend.total_page) ? { totalPage: num(backend.total_page) } : {}),
  }
}

// ---------------------------------------------------------------------------
// NeoReader ↔ plugin positions, given the book's spine

/** One `<itemref>`: its idref, the plugin's spine index (-1 when not readable) and byte range. */
export type NeoRef = { id: string; spine: number; start: number; end: number }
export type Local = { spine: number; offset: number }

/** Plugin position of a NeoReader point; undefined when the chapter is unknown. */
export function toLocal(point: NeoPoint, refs: readonly NeoRef[], mapFor: (spine: number) => ChapterMap): (Local & { exact: boolean }) | undefined {
  let index = refs[point.chapterIndex]?.id === point.chapterID || point.chapterID === undefined ? point.chapterIndex : -1
  if (index < 0) index = refs.findIndex((r) => r.id === point.chapterID)
  if (index < 0 || !refs[index]) return undefined
  const ref = refs[index]
  if (ref.spine < 0) {
    // Not a chapter the plugin shows: the next one.
    const next = refs.slice(index + 1).find((r) => r.spine >= 0)
    return next ? { spine: next.spine, offset: 0, exact: false } : undefined
  }
  return { spine: ref.spine, ...neoToOffset(mapFor(ref.spine), point) }
}

/** NeoReader fields of a plugin position (what a position string carries). */
export function toNeo(local: Local, refs: readonly NeoRef[], map: ChapterMap): Record<string, number | string | number[]> | undefined {
  const chapterIndex = refs.findIndex((r) => r.spine === local.spine)
  if (chapterIndex < 0) return undefined
  const ref = refs[chapterIndex]
  const at = offsetToNeo(map, local.offset)
  return {
    chapterIndex,
    nodePosition: at.nodePosition,
    textOffset: at.textOffset,
    chapterStartPosition: ref.start,
    chapterEndPosition: ref.end,
    chapterID: ref.id,
    xpath: at.xpath,
  }
}

// ---------------------------------------------------------------------------
// Decisions

const same = (a: Local | undefined, b: Local | undefined) => !!a && !!b && a.spine === b.spine && a.offset === b.offset

/** `device_model` written by a push. */
export const OWN_DEVICE = "OpenCode"

/** Our last acknowledged push of a book: the cloud update time it wrote and the page-turn time it carried. */
export type OwnPush = { pushedAt: number; turnedAt: number }

/** The cloud still holds our own push (the server time it wrote, from OpenCode). */
export function isOwnWrite(cloud: { updateTime: number; deviceModel?: string }, own: { pushedAt?: number } | undefined): boolean {
  return !!own?.pushedAt && cloud.deviceModel === OWN_DEVICE && cloud.updateTime === own.pushedAt
}

export type PushDecision = { push: true } | { push: false; reason: "no local reading" | "the Boox is newer" | "same position" }

/**
 * Push only a position the user reached by turning pages after the last
 * device save, and only a new one: a new position, or the same one with a
 * new `progress` (the push would write `progress.local`, the cloud holds
 * `progress.cloud`), so finishing or unfinishing on the same screen goes
 * through. When the cloud holds our own push, its update time is the
 * server's clock at that push: compare with the page-turn time that push
 * carried instead.
 */
export function decidePush(input: {
  turnedAt?: number
  cloudTime: number
  deviceModel?: string
  own?: OwnPush
  local: Local
  cloud?: Local
  progress?: { local: string; cloud: unknown }
}): PushDecision {
  if (!input.turnedAt) return { push: false, reason: "no local reading" }
  const since = isOwnWrite({ updateTime: input.cloudTime, deviceModel: input.deviceModel }, input.own) ? input.own!.turnedAt : input.cloudTime
  if (input.turnedAt <= since) return { push: false, reason: "the Boox is newer" }
  if (same(input.local, input.cloud) && (!input.progress || sameProgress(input.progress.local, input.progress.cloud)))
    return { push: false, reason: "same position" }
  return { push: true }
}

/** Same page count, current page and so finished state (total/total). */
function sameProgress(a: unknown, b: unknown): boolean {
  const pa = parseProgress(a)
  const pb = parseProgress(b)
  return !!pa && !!pb && pa.current === pb.current && pa.total === pb.total && (pa.current >= pa.total) === (pb.current >= pb.total)
}

/**
 * Open at the cloud position when the Boox saved or opened the book after the
 * last local page turn, the position differs, and it is not our own push.
 */
export function decidePull(input: {
  turnedAt?: number
  updateTime: number
  lastAccess: number
  deviceModel?: string
  pushedAt?: number
  local?: Local
  cloud?: Local
}): boolean {
  if (!input.cloud) return false
  if (isOwnWrite(input, input)) return false
  if (Math.max(input.updateTime, input.lastAccess) <= (input.turnedAt ?? 0)) return false
  return !same(input.local, input.cloud)
}

/**
 * One push at a time per book. A snapshot offered while that book's push is
 * running waits, replacing any older waiting one, and is sent right after.
 */
export function pushQueue<S extends { turnedAt: number }>(send: (key: string, snapshot: S) => Promise<void>): (key: string, snapshot: S) => Promise<void> {
  const running = new Map<string, Promise<void>>()
  const waiting = new Map<string, S>()
  const run = async (key: string, first: S) => {
    let next: S | undefined = first
    while (next) {
      await send(key, next).catch(() => {})
      next = waiting.get(key)
      waiting.delete(key)
    }
    running.delete(key)
  }
  return (key, snapshot) => {
    const busy = running.get(key)
    if (busy) {
      const queued = waiting.get(key)
      if (!queued || queued.turnedAt <= snapshot.turnedAt) waiting.set(key, snapshot)
      return busy
    }
    const started = run(key, snapshot)
    running.set(key, started)
    return started
  }
}

/**
 * `cur/total` pages for a percentage, on the doc's own page count: total/total
 * only for a book finished here, else from page 1 up to total - 1 (a
 * one-page book unfinished is 0/1).
 */
export function progressFor(percent: number, total: number, finished: boolean): string {
  if (finished) return `${total}/${total}`
  const last = total - 1
  const current = Math.min(last, Math.max(Math.min(1, last), Math.round((Math.min(100, Math.max(0, percent)) / 100) * total)))
  return `${current}/${total}`
}

// ---------------------------------------------------------------------------
// The patch

function skipSpace(s: string, i: number) {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}
function skipString(s: string, i: number) {
  for (i++; i < s.length; i++) {
    if (s[i] === "\\") i++
    else if (s[i] === '"') return i + 1
  }
  throw new Error("unterminated string")
}
function skipValue(s: string, i: number): number {
  i = skipSpace(s, i)
  if (s[i] === '"') return skipString(s, i)
  if (s[i] === "{" || s[i] === "[") {
    let depth = 0
    for (; i < s.length; i++) {
      if (s[i] === '"') i = skipString(s, i) - 1
      else if (s[i] === "{" || s[i] === "[") depth++
      else if ((s[i] === "}" || s[i] === "]") && --depth === 0) return i + 1
    }
    throw new Error("unterminated value")
  }
  while (i < s.length && !/[,}\]\s]/.test(s[i])) i++
  return i
}
/** Value spans of an object's members, and the index of its closing brace. */
function members(s: string, open: number): { spans: Map<string, [number, number]>; close: number } {
  const spans = new Map<string, [number, number]>()
  let i = skipSpace(s, open + 1)
  if (s[i] === "}") return { spans, close: i }
  for (;;) {
    i = skipSpace(s, i)
    const keyEnd = skipString(s, i)
    const key = JSON.parse(s.slice(i, keyEnd)) as string
    i = skipSpace(s, keyEnd)
    if (s[i] !== ":") throw new Error("bad object")
    const start = skipSpace(s, i + 1)
    const end = skipValue(s, start)
    spans.set(key, [start, end])
    i = skipSpace(s, end)
    if (s[i] === "}") return { spans, close: i }
    if (s[i] !== ",") throw new Error("bad object")
    i++
  }
}

/**
 * Sets members of the `backend` object inside an extraAttributes string,
 * leaving every other byte as it was. Undefined when the string is not the
 * expected shape or the result would differ elsewhere.
 */
export function setBackendFields(extra: string, fields: Record<string, unknown>): string | undefined {
  try {
    const root = members(extra, skipSpace(extra, 0))
    const span = root.spans.get("backend")
    if (!span || extra[span[0]] !== "{") return undefined
    const backend = members(extra, span[0])
    const edits: Array<[number, number, string]> = []
    const added: string[] = []
    for (const [key, value] of Object.entries(fields)) {
      const at = backend.spans.get(key)
      if (at) edits.push([at[0], at[1], JSON.stringify(value)])
      else added.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`)
    }
    if (added.length) {
      const empty = backend.spans.size === 0
      edits.push([backend.close, backend.close, (empty ? "" : ",") + added.join(",")])
    }
    let out = extra
    for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + text + out.slice(end)
    // Check: the result equals the original with only these fields changed.
    const expected = JSON.parse(extra) as { backend: Record<string, unknown> }
    Object.assign(expected.backend, fields)
    return JSON.stringify(JSON.parse(out)) === JSON.stringify(expected) ? out : undefined
  } catch {
    return undefined
  }
}

/** The fields a push may change. */
export const PATCHED = {
  top: ["progress", "updatedAt", "extraAttributes"],
  backend: [...POSITION_KEYS, "user_doc_data_update_time", "device_model"],
} as const

/**
 * The book doc with a new reading position: the three position strings,
 * `progress`, `user_doc_data_update_time`, `device_model` and `updatedAt`;
 * `_cv` is dropped. Undefined when the doc cannot be patched safely.
 */
export function patchBookDoc(
  doc: Doc,
  input: { fields: Record<string, number | string | number[]>; percent: number; finished: boolean; now: number },
): Doc | undefined {
  if (doc.modeType !== 4 || typeof doc._rev !== "string" || typeof doc.extraAttributes !== "string") return undefined
  const backend = backendOf(doc)
  if (!backend) return undefined
  const total = docTotal(doc)
  if (!total || total <= 0) return undefined
  const base: NeoPosition | undefined = POSITION_KEYS.map((key) => parseNeoPosition(backend[key])).find((p) => neoPoint(p))
  const positions = Object.fromEntries(
    POSITION_KEYS.map((key) => {
      const own = parseNeoPosition(backend[key])
      return [key, formatNeoPosition(withNeoFields(neoPoint(own) ? own : base, input.fields))]
    }),
  )
  const extraAttributes = setBackendFields(doc.extraAttributes, {
    ...positions,
    user_doc_data_update_time: input.now,
    device_model: OWN_DEVICE,
  })
  if (!extraAttributes) return undefined
  const { _cv: _dropped, ...rest } = doc
  return { ...rest, progress: progressFor(input.percent, total, input.finished), updatedAt: input.now, extraAttributes }
}
