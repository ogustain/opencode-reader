/**
 * TUI half of the opencode-reader plugin.
 *
 * `/read` picks a book from the server's library and opens it in the session
 * panel; `/books` browses the Boox library (the Onyx cloud's collections, or
 * the device over ADB without a cloud token). Positions are `{ spine, offset }`,
 * saved per book (debounced) in durable storage. Only the current chapter is
 * held, and only the visible lines are rendered.
 *
 * Sync with the Boox, for books copied from it: opening a book or the panel
 * pulls the cloud position when the Boox moved since both last agreed; closing the
 * panel, switching books or `pushIdleMinutes` without a page turn pushes the
 * local position (the server decides, GET then PUT). A push stays due in
 * storage until settled, and is sent again once at the next start or panel
 * opening. Without the cloud, or when a push fails, the panel and the
 * sidebar show "Boox: go to N %".
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import type { OnyxState } from "./onyx"
import {
  booxHint, chooseStart, column, contents, defaultDisplay, fromPercent, isFinished, keepsStored, lastScreen, layout, nextChapter, nextGen, previousScreen,
  progressOf, savedFinish, savedTimes, screenAt, turnForward, type Display, type Position,
} from "./paginate"
import {
  ReaderRpc, type BookEntry, type BooxListing, type ChapterResult, type CloudListing, type FetchResult, type LibraryResult, type OpenResult,
  type PullResult, type PushResult, type SyncSettings,
} from "./rpc"
import {
  batchSummary, downloadBatch, EXPIRED_MESSAGE, libraryTree, pendingPushes, pushQueue, settles, syncFailure, UNMAPPED_MESSAGE, type TreeNode,
} from "./sync"
import type { Paragraph } from "./text"

const PANEL = "opencode-reader"
const SIDEBAR_COLUMNS = 37
const SAVE_DELAY_MS = 800
const BOOX_MIN_INTERVAL_MS = 60_000
const PULL_MIN_INTERVAL_MS = 60_000

/** The fields of the host's `session.panel` input (PanelInput) this panel uses. */
type PanelInput = {
  readonly width: number
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}
type Saved = {
  path: string
  title: string
  spine: number
  offset: number
  percent: number
  /** Epoch ms of the last page turn here, 0 before any: the conflict tiebreak with the Boox's last save. */
  updatedAt: number
  /** Local generation: bumped by every position change here (a page turn, or a Boox position applied). */
  gen?: number
  /** Epoch ms of the last opening, for "recent first". */
  openedAt?: number
  /** Path on the Boox, for books copied from it (the ones that sync). */
  booxPath?: string
  /** Read to the end at this position, by a forward page turn. */
  finished?: boolean
  boox?: { percent: number; lastAccess: number; checkedAt: number }
  /**
   * Last push: "sent" or "failed". `gen`, `turnedAt`: generation and
   * page-turn time of the last reading the cloud acknowledged (older versions
   * kept only `turnedAt`).
   */
  cloud?: { state: "sent" | "failed"; at: number; gen?: number; turnedAt?: number }
  /** Generation of a reading whose push is due and not settled yet: sent again after a restart. */
  pending?: number
}
type Book = { key: string; path: string; title: string; author?: string; booxPath?: string; chapters: number[]; titles: Array<string | undefined> }
type CloudEntry = CloudListing["books"][number]
type Snapshot = { book: Book; position: Position; percent: number; finished: boolean; gen: number; turnedAt: number }

/** Display settings and their choices, in dialog order. */
const DISPLAY: { [K in keyof Display]: { title: string; choices: Array<{ value: Display[K]; title: string }> } } = {
  width: {
    title: "Text width",
    choices: [
      { value: "full", title: "Full panel width" },
      { value: 100, title: "100 columns" },
      { value: 80, title: "80 columns" },
      { value: 66, title: "66 columns" },
    ],
  },
  paragraphs: {
    title: "Paragraph spacing",
    choices: [
      { value: "blank", title: "Blank line between paragraphs" },
      { value: "indent", title: "No blank line, indented first line" },
    ],
  },
  lines: {
    title: "Line spacing",
    choices: [
      { value: "normal", title: "Normal" },
      { value: "airy", title: "Airy (blank line between lines)" },
    ],
  },
  align: {
    title: "Alignment",
    choices: [
      { value: "left", title: "Left" },
      { value: "justify", title: "Justified" },
    ],
  },
}
type AnyChoice = { value: Display[keyof Display]; title: string }

const pct = (value: number) => `${Math.floor(value)} %`
const fit = (text: string, width: number) => {
  const chars = Array.from(text)
  return width <= 0 ? "" : chars.length <= width ? text : chars.slice(0, width - 1).join("") + "…"
}
const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export default Plugin.define({
  id: "opencode-reader.tui",
  async setup(context) {
    const reader = context.client.rpc(ReaderRpc)
    const [store, setStore] = context.storage.store<{ books: Record<string, Saved>; current: string | null }>("positions", {
      initial: { books: {}, current: null },
    })
    const [view, setView] = context.storage.store<{ open: boolean }>("reading-view", { initial: { open: true } })
    // Global display settings; defaults fill keys missing from older saves.
    const [displayStore, setDisplay] = context.storage.store<Partial<Display>>("reader-display", { initial: {} })
    const display = (): Display => ({ ...defaultDisplay, ...displayStore })

    const [book, setBook] = createSignal<Book>()
    const [position, setPosition] = createSignal<Position>({ spine: 0, offset: 0 })
    const [chapter, setChapter] = createSignal<{ key: string; spine: number; paragraphs: Paragraph[] }>()
    const [notice, setNotice] = createSignal("")
    const [booxStatus, setBooxStatus] = createSignal("")

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Reader", message, variant })
    const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

    // Where a forward page turn reached the book's last screen: finished (100 %) while the reader stays there.
    const [finishedAt, setFinishedAt] = createSignal<{ key: string; spine: number; offset: number }>()
    const finished = () => {
      const b = book()
      const pos = position()
      const at = finishedAt()
      return !!b && at?.key === b.key && at.spine === pos.spine && at.offset === pos.offset
    }
    const percent = () => {
      const b = book()
      return b ? progressOf(b.chapters, position(), finished()) : 0
    }

    // The reading held here: its book, the generation of the current position
    // (bumped past every window's by a turn or an applied Boox position) and
    // its page-turn time (a turn sets it; 0 before any). Opening keeps the
    // saved ones. They go with the position, in saves and pushes.
    let reading = { key: "", gen: 0, turnedAt: 0 }
    const held = (key: string) => (reading.key === key ? reading : { key, gen: 0, turnedAt: 0 })
    const bump = (key: string, turnedAt: number) => {
      reading = { key, gen: nextGen(held(key).gen, store.books[key]?.gen), turnedAt }
    }

    // Debounced save of the current position; flushed on close and unload.
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const flush = (opened = false) => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = undefined
      const b = book()
      if (!b) return
      const pos = position()
      const value = percent()
      const done = finished()
      const now = Date.now()
      const { gen, turnedAt } = held(b.key)
      void setStore((draft) => {
        const previous = draft.books[b.key]
        draft.current = b.key
        // Another window moved later: keep its position, generation and time.
        if (keepsStored(previous, gen)) {
          if (opened) previous!.openedAt = now
          return
        }
        draft.books[b.key] = {
          ...previous,
          path: b.path,
          title: b.title,
          ...(b.booxPath ? { booxPath: b.booxPath } : {}),
          spine: pos.spine,
          offset: pos.offset,
          percent: value,
          finished: done,
          gen,
          ...savedTimes(previous, { turnedAt, opened, now }),
        }
      }).catch(() => {})
    }
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => flush(), SAVE_DELAY_MS)
    }

    // At most three decoded chapters: current and its neighbours.
    const chapters = new Map<string, Paragraph[]>()
    const ensureChapter = async (b: Book, spine: number): Promise<Paragraph[] | undefined> => {
      const id = `${b.key}:${spine}`
      let paragraphs = chapters.get(id)
      if (!paragraphs) {
        const result = (await reader.chapter({ path: b.path, spine }).catch((e) => ({ ok: false, error: failure(e) }))) as ChapterResult
        if (!result.ok) {
          setNotice(`Cannot read chapter: ${result.error}`)
          return undefined
        }
        paragraphs = result.paragraphs
        chapters.set(id, paragraphs)
        while (chapters.size > 3) chapters.delete(chapters.keys().next().value!)
      }
      if (book()?.key === b.key && position().spine === spine) setChapter({ key: b.key, spine, paragraphs })
      return paragraphs
    }

    /**
     * `user`: a page turn or chapter jump by the reader, as opposed to opening or resuming.
     * `finish`: a forward turn onto the book's last screen (or a finish saved there).
     */
    const goTo = async (pos: Position, user = true, finish = false) => {
      const b = book()
      if (!b) return
      if (user) {
        bump(b.key, Date.now())
        scheduleIdlePush()
      }
      setFinishedAt(finish ? { key: b.key, ...pos } : undefined)
      setPosition(pos)
      setNotice("")
      scheduleSave()
      await ensureChapter(b, pos.spine)
    }

    // ---- Sync with the Boox through the Onyx cloud --------------------------------
    let syncSettings: SyncSettings | undefined
    const settings = async () => (syncSettings ??= (await reader.settings({}).catch(() => undefined)) as SyncSettings | undefined)
    const [cloudState, setCloudState] = createSignal<OnyxState>()
    let expiredShown = false
    const noteCloud = (state: OnyxState, error?: string) => {
      setCloudState(state)
      if (state === "expired" && !expiredShown) {
        expiredShown = true
        toast(error ?? EXPIRED_MESSAGE, "warning")
      }
    }
    /** A failed sync of a book: its state, and its cause in a toast once per book and cause this session. */
    const toldFailures = new Set<string>()
    const tellFailure = (key: string, cause: string | undefined) => {
      if (!cause || toldFailures.has(`${key}\n${cause}`)) return
      toldFailures.add(`${key}\n${cause}`)
      toast(`Boox sync failed: ${cause}`, "warning")
    }
    const noteFailure = (key: string, state: OnyxState, error?: string) => {
      noteCloud(state, error)
      tellFailure(key, syncFailure(state, error))
    }
    /** The "go to N %" hint is for when the cloud cannot carry the position. */
    const cloudCarries = (saved: Saved | undefined) => cloudState() === "ok" && saved?.cloud?.state !== "failed"
    const sentToBoox = (saved: Saved | undefined) =>
      saved?.cloud?.state === "sent" && (saved.cloud.gen !== undefined ? saved.cloud.gen >= (saved.gen ?? 0) : (saved.cloud.turnedAt ?? 0) >= saved.updatedAt)
    /** The last push failed, or the cloud could not be read: the next push or pull tries again. */
    const syncFailed = (saved: Saved | undefined) => saved?.cloud?.state === "failed" || cloudState() === "offline" || cloudState() === "error"

    const snapshot = (): Snapshot | undefined => {
      const b = book()
      if (!b) return undefined
      const { gen, turnedAt } = held(b.key)
      return { book: b, position: position(), percent: percent(), finished: finished(), gen, turnedAt }
    }
    const setCloud = (key: string, cloud: Saved["cloud"]) =>
      void setStore((draft) => {
        const saved = draft.books[key]
        if (!saved) return
        if (cloud) saved.cloud = cloud
        else delete saved.cloud
      }).catch(() => {})

    /**
     * What the cloud acknowledged per book: the generation and page-turn time
     * of the reading it holds. Kept in memory too, as store writes land
     * asynchronously.
     */
    type Ack = { gen?: number; turnedAt?: number }
    const acked = new Map<string, Ack>()
    const ackOf = (key: string): Ack | undefined => {
      const cloud = store.books[key]?.cloud
      return acked.get(key) ?? (cloud ? { gen: cloud.gen, turnedAt: cloud.turnedAt } : undefined)
    }
    const acknowledge = (key: string, ack: Ack) => {
      acked.set(key, ack)
      setCloud(key, { state: "sent", at: Date.now(), ...ack })
    }
    /** Whether the cloud already holds this reading (older receipts: by page-turn time). */
    const inCloud = (s: Snapshot) => {
      const ack = ackOf(s.book.key)
      return ack?.gen !== undefined ? s.gen <= ack.gen : (ack?.turnedAt ?? 0) >= s.turnedAt
    }
    const syncable = (s: Snapshot | undefined): s is Snapshot => !!s?.book.booxPath && (s.gen > 0 || s.turnedAt > 0)

    /** A push of this reading is due: kept in storage until settled, so a lost one is sent again after a restart. */
    const markPending = (s: Snapshot | undefined) => {
      if (!syncable(s) || inCloud(s)) return
      void setStore((draft) => {
        const saved = draft.books[s.book.key]
        if (saved && (saved.pending ?? -1) < s.gen) saved.pending = s.gen
      }).catch(() => {})
    }
    /** The reading of generation `gen` (or an older one) needs no push any more: sent, already there, or not to be sent. */
    const settle = (key: string, gen: number) => {
      if (settles(store.books[key]?.pending, gen))
        void setStore((draft) => {
          const saved = draft.books[key]
          if (saved && settles(saved.pending, gen)) delete saved.pending
        }).catch(() => {})
    }

    /** Offers one snapshot to the server, which pushes it, or says to pull, or that both sides agree. */
    const pushOnce = async (key: string, s: Snapshot) => {
      if (!syncable(s)) return
      if (inCloud(s)) return settle(key, s.gen)
      if (!(await settings())?.cloud) return
      const ack = ackOf(key)
      const result = (await reader
        .push({
          path: s.book.path, booxPath: s.book.booxPath, spine: s.position.spine, offset: s.position.offset, percent: s.percent, finished: s.finished,
          gen: s.gen, turnedAt: s.turnedAt, ...(ack?.turnedAt !== undefined ? { receipt: ack.turnedAt } : {}),
        })
        .catch((e) => ({ ok: false, state: "error", error: failure(e) }))) as PushResult
      if (!result.ok) {
        noteFailure(key, result.state, result.error)
        // The cloud still holds the last acknowledged push.
        if (result.state !== "off") setCloud(key, { state: "failed", at: Date.now(), ...(ack ?? {}) })
        return
      }
      setCloudState("ok")
      // Acknowledge the snapshot that was sent, not whatever was read meanwhile.
      if (result.pushed || result.reason === "same position") acknowledge(key, { gen: s.gen, turnedAt: s.turnedAt })
      else if (result.reason === "in sync") acked.set(key, { gen: s.gen })
      // Sent, already there, or to be pulled (when the book is open here; opening it pulls anyway). Failures stay due.
      settle(key, s.gen)
      const b = book()
      if (!result.pushed && result.pull && b?.key === key) void syncPull(b, true)
    }
    const queuePush = pushQueue<Snapshot>(pushOnce)
    /** Pushes per book run one at a time; the latest snapshot offered meanwhile goes next. */
    const syncPush = (s: Snapshot | undefined) => {
      if (!syncable(s)) return Promise.resolve()
      markPending(s)
      return queuePush(s.book.key, s)
    }
    /** Due pushes left by an earlier session (closed before the answer, or failed): offered once, through the same decision. */
    const replayed = new Set<string>()
    const replayPending = async () => {
      if (!(await settings())?.cloud) return
      for (const key of pendingPushes(store.books, replayed)) {
        replayed.add(key)
        const s = store.books[key]
        const entry = { key, path: s.path, title: s.title, booxPath: s.booxPath, chapters: [], titles: [] }
        const position = { spine: s.spine, offset: s.offset }
        void queuePush(key, { book: entry, position, percent: s.percent, finished: s.finished === true, gen: s.gen ?? 0, turnedAt: s.updatedAt })
      }
    }
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleIdlePush = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const minutes = syncSettings?.pushIdleMinutes ?? 5
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        flush()
        void syncPush(snapshot())
      }, minutes * 60_000)
    }

    /**
     * Opens at the cloud position when the server says to pull (`reconcile`):
     * once a minute per book at most, except when the book is opened (`force`).
     */
    const lastPull = new Map<string, number>()
    const syncPull = async (b: Book, force = false) => {
      if (!b.booxPath) return
      if (!force && Date.now() - (lastPull.get(b.key) ?? 0) < PULL_MIN_INTERVAL_MS) return
      if (!(await settings())?.cloud) {
        setCloudState("off")
        return
      }
      lastPull.set(b.key, Date.now())
      const before = position()
      // The local reading: this window's, or a later one saved by another window.
      const saved = store.books[b.key]
      const local = (saved?.gen ?? 0) > held(b.key).gen ? { gen: saved!.gen!, turnedAt: saved!.updatedAt } : held(b.key)
      const receipt = ackOf(b.key)?.turnedAt
      const result = (await reader
        .pull({ path: b.path, booxPath: b.booxPath, gen: local.gen, turnedAt: local.turnedAt, ...(receipt !== undefined ? { receipt } : {}) })
        .catch((e) => ({ ok: false, state: "error", error: failure(e) }))) as PullResult
      if (!result.ok) {
        noteFailure(b.key, result.state, result.error)
        return
      }
      setCloudState("ok")
      const c = result.cloud
      if (c.percent !== undefined)
        void setStore((draft) => void (draft.books[b.key] && (draft.books[b.key].boox = { percent: c.percent!, lastAccess: c.lastAccess, checkedAt: Date.now() }))).catch(() => {})
      // The reader moved meanwhile: their move wins (the next push is a conflict they win).
      if (c.action !== "pull" || book()?.key !== b.key || position() !== before) return
      const remote = c.spine !== undefined && c.offset !== undefined && c.spine < b.chapters.length ? { spine: c.spine, offset: c.offset } : undefined
      if (!remote) {
        if (c.unmapped || c.spine !== undefined) tellFailure(b.key, UNMAPPED_MESSAGE)
        return
      }
      const moved = remote.spine !== before.spine || remote.offset !== before.offset
      if (moved) {
        bump(b.key, held(b.key).turnedAt) // A position change, not a page turn: the turn time stays.
        await goTo(remote, false)
        flush()
      }
      const gen = held(b.key).gen
      const agreed = (await reader.agree({ booxPath: b.booxPath, print: c.print, gen }).catch(() => undefined)) as { ok?: boolean } | undefined
      if (agreed?.ok) acked.set(b.key, { gen }) // The cloud holds this reading (the Boox's, not a push: no "sent").
      setCloud(b.key, undefined)
      settle(b.key, gen)
      if (moved) toast(`Opened at the Boox position (${pct(percent())}).`, "success")
    }

    /** Loads a book's index; starts at `start(book)`, else at its saved position, then checks the cloud. */
    const loadBook = async (
      entry: { key: string; path: string; title: string; booxPath?: string },
      start?: (book: Book) => Position,
    ): Promise<Book | undefined> => {
      const previous = snapshot()
      if (previous) {
        flush()
        if (previous.book.key !== entry.key) void syncPush(previous)
      }
      // Positions saved before sync existed have no Boox path: the server's library knows it.
      if (!entry.booxPath && entry.key.startsWith("boox-")) {
        const library = (await reader.library({}).catch(() => undefined)) as LibraryResult | undefined
        const known = library?.books.find((b) => b.key === entry.key)?.booxPath
        if (known) entry = { ...entry, booxPath: known }
      }
      const result = (await reader.open({ path: entry.path }).catch((e) => ({ ok: false, error: failure(e) }))) as OpenResult
      if (!result.ok) {
        toast(`Cannot open ${entry.title}: ${result.error}`, "error")
        return undefined
      }
      const b: Book = {
        key: entry.key,
        path: entry.path,
        title: result.title || entry.title,
        author: result.author,
        ...(entry.booxPath ? { booxPath: entry.booxPath } : {}),
        chapters: result.chapters.map((c) => c.chars),
        titles: result.chapters.map((c) => c.title),
      }
      const saved = store.books[entry.key]
      const first = b.chapters[0] > 0 ? 0 : (nextChapter(b.chapters, 0, 1) ?? 0)
      const pos = start?.(b) ?? (saved && saved.spine < b.chapters.length ? { spine: saved.spine, offset: saved.offset } : { spine: first, offset: 0 })
      reading = { key: b.key, gen: saved?.gen ?? 0, turnedAt: saved?.updatedAt ?? 0 }
      setBook(b)
      setChapter(undefined)
      await goTo(pos, false, savedFinish(saved, pos))
      flush(true)
      if (!start) void syncPull(b, true)
      return b
    }

    const openPanel = () => {
      if (!context.ui.panel.open(PANEL)) toast("Open a session first, then /read.", "warning")
    }

    // Boox listing: asked when /books runs and when the panel opens, never more than once a minute.
    let lastBoox = 0
    const refreshBoox = async (force = false): Promise<BooxListing | undefined> => {
      if (!force && Date.now() - lastBoox < BOOX_MIN_INTERVAL_MS) return undefined
      lastBoox = Date.now()
      const listing = (await reader.boox({ refresh: true }).catch(() => undefined)) as BooxListing | undefined
      if (!listing) return undefined
      setBooxStatus(listing.state === "ok" ? "" : listing.message)
      const known = listing.books.filter((b) => store.books[b.key] && b.percent !== undefined)
      if (known.length)
        void setStore((draft) => {
          for (const b of known)
            draft.books[b.key].boox = { percent: b.percent!, lastAccess: b.lastAccess, checkedAt: listing.checkedAt ?? Date.now() }
        }).catch(() => {})
      return listing
    }

    const readCommand = async () => {
      const library = (await reader.library({}).catch(() => undefined)) as LibraryResult | undefined
      if (!library) return toast("Reader server plugin unavailable.", "error")
      if (library.books.length === 0) return toast(`No EPUB in ${context.ui.format.path(library.dir)}. Use /books for the Boox.`, "warning")
      const recency = (b: BookEntry) => Math.max(store.books[b.key]?.updatedAt ?? 0, store.books[b.key]?.openedAt ?? 0)
      const books = [...library.books].sort((a, b) => recency(b) - recency(a) || a.title.localeCompare(b.title))
      const choice = await context.ui.dialog.select<BookEntry>({
        title: "Read",
        placeholder: "Search books",
        current: books.find((b) => b.key === store.current),
        options: books.map((b) => {
          const saved = store.books[b.key]
          return {
            title: b.title,
            value: b,
            description: [b.author, saved ? pct(saved.percent) : undefined].filter(Boolean).join(" · ") || undefined,
            category: saved ? "Recent" : b.source === "boox" ? "From the Boox" : "Books",
          }
        }),
      })
      if (!choice) return
      if (await loadBook(choice)) openPanel()
    }

    /** `/books` without the cloud: the device's library over ADB, with the "go to N %" hint for the way back. */
    const booksOverAdb = async () => {
      toast("Reading the Boox library…")
      const listing = (await refreshBoox(true)) ?? ((await reader.boox({}).catch(() => undefined)) as BooxListing | undefined)
      if (!listing) return toast("Reader server plugin unavailable.", "error")
      if (listing.books.length === 0) return toast(listing.state === "ok" ? "No EPUB on the Boox." : listing.message, "warning")
      const books = [...listing.books].sort((a, b) => b.lastAccess - a.lastAccess || a.title.localeCompare(b.title))
      const choice = await context.ui.dialog.select({
        title: listing.state === "ok" ? "Boox library" : `Boox library (last known: ${listing.message})`,
        placeholder: "Search books",
        options: books.map((b) => ({
          title: b.title,
          value: b,
          description: [
            b.authors,
            b.percent !== undefined ? `${pct(b.percent)} (${b.current}/${b.total})` : "not started",
            b.lastAccess ? `read ${day(b.lastAccess)}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
      })
      if (!choice) return
      const fetched = await fetchBook(choice)
      if (fetched.expired) noteCloud("expired", EXPIRED_MESSAGE)
      if (!fetched.ok) {
        if (fetched.error === EXPIRED_MESSAGE) return
        return toast(fetched.notHere ? fetched.error : `Cannot get ${choice.title}: ${fetched.error}`, fetched.notHere ? "warning" : "error")
      }
      const saved = store.books[fetched.book.key]
      const boox = choice.percent !== undefined ? { percent: choice.percent, lastAccess: choice.lastAccess, checkedAt: Date.now() } : undefined
      const from = chooseStart(saved, boox)
      const opened = await loadBook(fetched.book, from === "boox" && boox ? (b) => fromPercent(b.chapters, boox.percent) : undefined)
      if (!opened) return
      if (from === "boox" && boox) toast(`Opened at the Boox position (${pct(boox.percent)}).`, "success")
      else if (saved && boox) toast(`Opened at your OpenCode position (${pct(percent())}), newer than the Boox.`, "success")
      else if (saved) toast(`Opened at your OpenCode position (${pct(percent())}); not started on the Boox.`)
      if (boox) void setStore((draft) => void (draft.books[opened.key] && (draft.books[opened.key].boox = boox))).catch(() => {})
      openPanel()
    }

    /** The book's file on this computer: cached, else downloaded from the Onyx cloud, else copied over ADB. */
    const fetchBook = async (choice: { title: string; path: string; size: number; cached?: string }, quiet = false, cloud = true) => {
      if (!choice.cached && !quiet) toast((await settings())?.cloud ? `Downloading ${choice.title} from the Onyx cloud…` : `Copying ${choice.title} from the Boox…`)
      return (await reader.fetch({ booxPath: choice.path, size: choice.size, ...(cloud ? {} : { cloud: false }) }).catch((e) => ({ ok: false, error: failure(e) }))) as FetchResult
    }

    const openCloudBook = async (choice: CloudEntry) => {
      const fetched = await fetchBook(choice)
      if (fetched.expired) noteCloud("expired", EXPIRED_MESSAGE)
      if (!fetched.ok) {
        if (fetched.error === EXPIRED_MESSAGE) return
        return toast(fetched.notHere ? fetched.error : `Cannot get ${choice.title}: ${fetched.error}`, "warning")
      }
      if (await loadBook(fetched.book)) openPanel()
    }

    /** Where a book's file is: on this computer, uploaded to the cloud (the Boox's hint), or only on the Boox. */
    const fileMarker = (b: CloudEntry) => (b.cached ? "on this computer" : b.uploaded ? "in the cloud" : "Boox only")

    const downloadUnfinished = async (books: CloudEntry[]) => {
      const todo = books.filter((b) => !b.finished && !b.cached)
      if (todo.length === 0) return toast("Every unfinished book is already on this computer.")
      toast(`Downloading ${todo.length} books (Onyx cloud, then the Boox)…`)
      // After a token refusal the rest go over ADB only, and the expiry is said once, with the summary.
      const { downloaded, onBoox, failed, expired } = await downloadBatch(todo, (b, cloud) => fetchBook(b, true, cloud))
      const summary = batchSummary({ downloaded, onBoox, failed: failed.map((f) => ({ title: f.book.title, error: f.error })) })
      if (expired) {
        setCloudState("expired")
        expiredShown = true
      }
      toast(expired ? `${summary}. ${EXPIRED_MESSAGE}` : summary, onBoox || failed.length || expired ? "warning" : "success")
    }

    /** `/books` with the cloud: collection → sub-collection → book, as on the Boox. */
    const booksCommand = async () => {
      if (!(await settings())?.cloud) return booksOverAdb()
      toast("Reading the Boox library…")
      let listing = (await reader.cloud({ refresh: true }).catch(() => undefined)) as CloudListing | undefined
      if (!listing) return toast("Reader server plugin unavailable.", "error")
      noteCloud(listing.state, listing.message)
      if (listing.books.length === 0) {
        if (listing.state === "ok") return toast("No EPUB in the Boox library.", "warning")
        toast(listing.message, "warning")
        return booksOverAdb()
      }
      type Choice = { node: string } | { book: CloudEntry } | { finished: true } | { copy: true }
      const LOOSE = "#loose"
      let showFinished = false
      let path: string[] = []
      let current: Choice | undefined
      for (;;) {
        const { root, finished } = libraryTree({ collections: listing.collections, books: listing.books }, { showFinished })
        const loose: TreeNode = { id: LOOSE, name: "Not in a collection", children: [], books: root.books, count: root.books.length }
        // Walk down the path again (the tree changes when finished books are shown).
        const trail: TreeNode[] = []
        let node = root
        for (const id of path) {
          const next = id === LOOSE ? loose : node.children.find((c) => c.id === id)
          if (!next) break
          trail.push(next)
          node = next
        }
        path = trail.map((n) => n.id!)
        const atRoot = trail.length === 0
        const collections = atRoot && loose.count ? [...root.children, loose] : node.children
        const books = atRoot ? [] : (node.books as CloudEntry[])
        const options: Array<{ title: string; value: Choice; description?: string; category?: string }> = [
          ...collections.map((c) => ({ title: `${c.name} ›`, value: { node: c.id! } as Choice, description: `${c.count} ${c.count === 1 ? "book" : "books"}`, category: "Collections" })),
          ...books.map((b) => ({
            title: b.title,
            value: { book: b } as Choice,
            description: [b.percent !== undefined ? pct(b.percent) : "not started", b.lastAccess ? `read ${day(b.lastAccess)}` : undefined, fileMarker(b)]
              .filter(Boolean)
              .join(" · "),
            category: "Books",
          })),
          ...(atRoot && finished
            ? [{ title: showFinished ? "Hide finished books" : `Show finished books (${finished})`, value: { finished: true } as Choice, category: "Options" }]
            : []),
          // This view needs the cloud configured, so downloading is always possible.
          ...(atRoot ? [{ title: "Download all unfinished books", value: { copy: true } as Choice, category: "Options" }] : []),
        ]
        const where = ["Boox library", ...trail.map((n) => n.name)].join(" › ")
        const choice = await context.ui.dialog.select<Choice>({
          title: listing.state === "ok" ? where : `${where} (last known: ${listing.message})`,
          placeholder: "Search",
          current: options.find((o) => JSON.stringify(o.value) === JSON.stringify(current))?.value,
          options,
        })
        current = undefined
        if (!choice) {
          if (atRoot) return
          current = { node: path.at(-1)! }
          path = path.slice(0, -1)
          continue
        }
        if ("node" in choice) path = [...path, choice.node]
        else if ("finished" in choice) {
          showFinished = !showFinished
          current = choice
        } else if ("copy" in choice) {
          await downloadUnfinished(listing.books)
          listing = ((await reader.cloud({}).catch(() => undefined)) as CloudListing | undefined) ?? listing
          current = choice
        } else return openCloudBook(choice.book)
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-reader.read",
          title: "Reader: read a book",
          group: "Reader",
          palette: true,
          slash: { name: "read" },
          run: readCommand,
        },
        {
          id: "opencode-reader.books",
          title: "Reader: Boox library",
          group: "Reader",
          palette: true,
          slash: { name: "books" },
          run: booksCommand,
        },
      ],
    }))

    function ReaderPanel(props: { panel: PanelInput }) {
      const theme = usePlugin().theme
      const [height, setHeight] = createSignal(Math.max(5, context.renderer.height - 8))
      const width = () => Math.max(20, props.panel.width - 4)
      // The text column (narrower than the panel when a text width is set), centred.
      const textColumn = () => column(width(), display().width)
      const wrap = (paragraphs: Paragraph[]) => layout(paragraphs, textColumn().width, display())
      const saved = () => {
        const key = book()?.key
        return key ? store.books[key] : undefined
      }

      // After a plugin reload the book is gone from memory: reopen the last one.
      if (!book() && store.current && store.books[store.current]) {
        const s = store.books[store.current]
        void loadBook({ key: store.current, path: s.path, title: s.title, ...(s.booxPath ? { booxPath: s.booxPath } : {}) })
      }
      // Panel open: the cloud position (loadBook pulls by itself), or the Boox % over ADB without the cloud.
      void settings().then((s) => {
        if (!s?.cloud) {
          setCloudState("off")
          void refreshBoox()
          return
        }
        const b = book()
        if (b) void syncPull(b)
        void replayPending()
      })

      const lines = createMemo(() => {
        const c = chapter()
        return c && c.key === book()?.key && c.spine === position().spine ? wrap(c.paragraphs) : []
      })
      // The screen starts at the line holding the position: a resize (including the
      // panel gaining or losing focus) re-wraps but never shows earlier text.
      const screen = createMemo(() => screenAt(lines(), height(), position().offset))
      const hint = () => (cloudCarries(saved()) ? undefined : booxHint(percent(), saved()?.boox?.percent))

      // Keys pressed while a chapter loads are ignored: its page count is not known yet.
      const ready = () => chapter()?.key === book()?.key && chapter()?.spine === position().spine
      // A forward turn onto the last screen finishes the book (100 %) until the reader moves away.
      const nextPage = async () => {
        const b = book()
        if (!b || !ready()) return
        const from = position()
        const turn = await turnForward(b.chapters, from, lines(), height(), async (spine) => {
          const paragraphs = await ensureChapter(b, spine)
          return paragraphs ? wrap(paragraphs) : undefined
        })
        if (book()?.key !== b.key || position() !== from) return
        if (!turn.end || (turn.finished && !finished())) await goTo(turn.to, true, turn.finished)
        if (turn.end) setNotice("End of the book")
      }
      const previousPage = async () => {
        const b = book()
        if (!b || !ready()) return
        const offset = previousScreen(lines(), height(), position().offset)
        if (offset !== undefined) return goTo({ spine: position().spine, offset })
        const previous = nextChapter(b.chapters, position().spine, -1)
        if (previous === undefined) return setNotice("Start of the book")
        const paragraphs = await ensureChapter(b, previous)
        await goTo({ spine: previous, offset: lastScreen(paragraphs ? wrap(paragraphs) : [], height()) })
      }
      // While one of our dialogs is open the panel's keys stay off, so typing in its search box is not read as commands.
      const [dialogOpen, setDialogOpen] = createSignal(false)
      const withDialog = async (show: () => Promise<void>) => {
        if (dialogOpen()) return
        setDialogOpen(true)
        try {
          await show()
        } finally {
          setDialogOpen(false)
        }
      }
      const showContents = () =>
        withDialog(async () => {
          const b = book()
          if (!b) return
          const spine = await context.ui.dialog.select<number>({
            title: "Contents",
            placeholder: "Search chapters",
            current: position().spine,
            options: contents(b.chapters, b.titles).map((c) => ({ title: c.title, value: c.spine, description: pct(c.percent) })),
          })
          if (spine !== undefined && book()?.key === b.key) await goTo({ spine, offset: 0 })
        })

      // Settings apply at once; the position does not move, so the top line keeps its text.
      const showSettings = () =>
        withDialog(async () => {
          let last: keyof Display | undefined
          for (;;) {
            const current = display()
            const label = (key: keyof Display) => (DISPLAY[key].choices as AnyChoice[]).find((c) => c.value === current[key])?.title
            const key = await context.ui.dialog.select<keyof Display>({
              title: "Display (font size follows the terminal: Cmd + / Cmd −)",
              current: last,
              options: (Object.keys(DISPLAY) as Array<keyof Display>).map((k) => ({ title: DISPLAY[k].title, value: k, description: label(k) })),
            })
            if (!key) return
            last = key
            const value = await context.ui.dialog.select<Display[keyof Display]>({
              title: DISPLAY[key].title,
              current: current[key],
              options: (DISPLAY[key].choices as AnyChoice[]).map((c) => ({ title: c.title, value: c.value })),
            })
            if (value !== undefined) await setDisplay((draft) => void ((draft as Record<string, unknown>)[key] = value)).catch(() => {})
          }
        })

      context.keymap.layer(() => ({
        priority: 10,
        enabled: () => props.panel.focused && !dialogOpen(),
        commands: [
          // Space is a silent alias of → (not in the hint line).
          { title: "Next page", group: "Reader", bind: "right,space", run: () => void nextPage() },
          { title: "Previous page", group: "Reader", bind: "left", run: () => void previousPage() },
          { title: "Contents", group: "Reader", bind: "t", run: () => void showContents() },
          { title: "Display settings", group: "Reader", bind: "s", run: () => void showSettings() },
          { title: "Full screen", group: "Reader", bind: "f", run: () => props.panel.toggleFullscreen() },
          { title: "Close the book", group: "Reader", bind: "q,escape", run: () => props.panel.close() },
        ],
      }))
      // Closing the panel sends the position to the Boox.
      onCleanup(() => {
        const s = snapshot()
        flush()
        void syncPush(s)
      })

      const chapterTitle = () => {
        const b = book()
        return b ? (b.titles[position().spine] ?? `Chapter ${position().spine + 1}`) : ""
      }
      const status = () => {
        const b = book()
        if (!b) return ""
        return [pct(percent()), `ch ${position().spine + 1}/${b.chapters.length}`, `p ${screen().page + 1}/${screen().pages}`].join(" · ")
      }

      return (
        <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} onMouseUp={() => props.panel.focus()}>
          <Show when={book()} fallback={<text fg={theme.text.muted}>No book open. /read or /books.</text>}>
            {(b) => (
              <>
                <box flexDirection="row" gap={1} height={1}>
                  <text flexShrink={0} wrapMode="none" fg={theme.text.base}>
                    <b>{fit(b().title, width())}</b>
                  </text>
                </box>
                <text height={1} wrapMode="none" fg={theme.text.muted}>
                  {fit(chapterTitle(), width())}
                </text>
                <box
                  flexDirection="column"
                  flexGrow={1}
                  paddingTop={1}
                  paddingLeft={textColumn().margin}
                  onSizeChange={function () {
                    if (this.height > 1) setHeight(this.height - 1)
                  }}
                >
                  <Show when={chapter()} fallback={<text fg={theme.text.muted}>Loading…</text>}>
                    <Index each={screen().lines}>
                      {(line) => (
                        <text height={1} wrapMode="none" fg={theme.text.base}>
                          {line().heading ? <b>{line().text || " "}</b> : line().text || " "}
                        </text>
                      )}
                    </Index>
                  </Show>
                </box>
                <box flexDirection="row" gap={2} height={1}>
                  <text flexShrink={0} wrapMode="none" fg={theme.text.muted}>{status()}</text>
                  <Show when={hint()}>
                    {(n) => <text flexShrink={0} wrapMode="none" fg={theme.text.feedback.warning.base}>{`Boox: go to ${n()} %`}</text>}
                  </Show>
                  <Show when={sentToBoox(saved())}>
                    <text flexShrink={0} wrapMode="none" fg={theme.text.feedback.success.base}>Sent to Boox</text>
                  </Show>
                  <Show when={!!b().booxPath && !sentToBoox(saved()) && syncFailed(saved())}>
                    <text flexShrink={0} wrapMode="none" fg={theme.text.feedback.warning.base}>Sync failed — will retry</text>
                  </Show>
                  <Show when={notice() || booxStatus()}>
                    <text flexShrink={1} wrapMode="none" fg={theme.text.muted}>{notice() || booxStatus()}</text>
                  </Show>
                </box>
                {/* Always one line, focused or not: the text area's height must not depend on focus. */}
                <text height={1} wrapMode="none" fg={props.panel.focused ? theme.text.base : theme.text.muted}>
                  {fit(props.panel.focused ? "←/→ page · t contents · s settings · f fullscreen · q close" : "click to read", width())}
                </text>
              </>
            )}
          </Show>
        </box>
      )
    }

    function Sidebar() {
      const theme = usePlugin().theme
      const current = () => (store.current ? store.books[store.current] : undefined)
      const value = () => (book() && book()!.key === store.current ? percent() : (current()?.percent ?? 0))
      const hint = () => (cloudCarries(current()) ? undefined : booxHint(value(), current()?.boox?.percent))
      // A finished book leaves the sidebar; opening an unfinished one brings it back.
      const shown = () => {
        const s = current()
        return s && !isFinished({ percent: value(), updatedAt: s.updatedAt }, s.boox) ? s : undefined
      }
      const reopen = async () => {
        const s = current()
        if (!s || !store.current) return
        const entry = { key: store.current, path: s.path, title: s.title, ...(s.booxPath ? { booxPath: s.booxPath } : {}) }
        if (book()?.key !== store.current && !(await loadBook(entry))) return
        openPanel()
      }
      return (
        <Show when={shown()}>
          {(s) => (
            <box flexDirection="column">
              <box flexDirection="row" gap={1} onMouseUp={() => void setView((draft) => void (draft.open = !draft.open)).catch(() => {})}>
                <text flexShrink={0} fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
                <text flexShrink={0} fg={theme.text.base}>
                  <b>Reading</b>
                </text>
                <box flexGrow={1} />
                <Show when={!view.open}>
                  <text flexShrink={0} wrapMode="none" fg={hint() ? theme.text.feedback.warning.base : theme.text.muted}>
                    {pct(value())}
                  </text>
                </Show>
              </box>
              <Show when={view.open}>
                <box onMouseUp={() => void reopen()}>
                  <text wrapMode="none" fg={theme.text.base}>
                    {`📖 ${fit(s().title, SIDEBAR_COLUMNS - 3 - 3 - pct(value()).length)} — ${pct(value())}`}
                  </text>
                </box>
                <Show when={hint()}>
                  {(n) => <text wrapMode="none" fg={theme.text.feedback.warning.base}>{`Boox: go to ${n()} %`}</text>}
                </Show>
              </Show>
            </box>
          )}
        </Show>
      )
    }

    const disposePanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <ReaderPanel panel={panel} />
        </Show>
      ),
    })
    const disposeSidebar = context.ui.slot({ append: "sidebar.content", render: () => <Sidebar /> })

    // Startup: send the pushes an earlier session left due.
    void replayPending()

    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      // Exiting: the push is not awaited here; it stays due and the next session sends it.
      const s = snapshot()
      flush()
      markPending(s)
      disposePanel()
      disposeSidebar()
    }
  },
})
