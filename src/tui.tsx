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
 * pulls the cloud position when the Boox read it more recently; closing the
 * panel, switching books or `pushIdleMinutes` without a page turn pushes the
 * local position (the server decides, GET then PUT). Without the cloud, or
 * when a push fails, the panel and the sidebar show "Boox: go to N %".
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import type { OnyxState } from "./onyx"
import {
  booxHint, chooseStart, column, contents, defaultDisplay, fromPercent, isFinished, lastScreen, layout, nextChapter, previousScreen, progressOf,
  savedFinish, savedTimes, screenAt, turnForward, type Display, type Position,
} from "./paginate"
import {
  ReaderRpc, type BookEntry, type BooxListing, type ChapterResult, type CloudListing, type FetchResult, type LibraryResult, type OpenResult,
  type PullResult, type PushResult, type SyncSettings,
} from "./rpc"
import { decidePull, downloadBatch, EXPIRED_MESSAGE, libraryTree, pushQueue, type OwnPush, type TreeNode } from "./sync"
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
  /** Epoch ms of the last page turn here, 0 before any: compared with the Boox's last read. */
  updatedAt: number
  /** Epoch ms of the last opening, for "recent first". */
  openedAt?: number
  /** Path on the Boox, for books copied from it (the ones that sync). */
  booxPath?: string
  /** Read to the end at this position, by a forward page turn. */
  finished?: boolean
  boox?: { percent: number; lastAccess: number; checkedAt: number }
  /**
   * Last push: "sent" or "failed". `turnedAt`: page-turn time of the last
   * snapshot the cloud acknowledged; `pushedAt`: the update time it wrote.
   */
  cloud?: { state: "sent" | "failed"; at: number; turnedAt?: number; pushedAt?: number }
}
type Book = { key: string; path: string; title: string; author?: string; booxPath?: string; chapters: number[]; titles: Array<string | undefined> }
type CloudEntry = CloudListing["books"][number]
type Snapshot = { book: Book; position: Position; percent: number; finished: boolean; turnedAt: number }

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

    // Debounced save of the current position; flushed on close and unload.
    // `turnedAt`: when the reader last turned a page since the last save (not set by opening or resuming).
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let turnedAt: number | undefined
    const flush = (opened = false) => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = undefined
      const b = book()
      if (!b) return
      const pos = position()
      const value = percent()
      const done = finished()
      const times = { ...(turnedAt !== undefined ? { turnedAt } : {}), opened, now: Date.now() }
      turnedAt = undefined
      void setStore((draft) => {
        const previous = draft.books[b.key]
        draft.books[b.key] = {
          ...previous,
          path: b.path,
          title: b.title,
          ...(b.booxPath ? { booxPath: b.booxPath } : {}),
          spine: pos.spine,
          offset: pos.offset,
          percent: value,
          finished: done,
          ...savedTimes(previous, times),
        }
        draft.current = b.key
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
        turnedAt = Date.now()
        lastTurn = { key: b.key, at: turnedAt }
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
    /** The "go to N %" hint is for when the cloud cannot carry the position. */
    const cloudCarries = (saved: Saved | undefined) => cloudState() === "ok" && saved?.cloud?.state !== "failed"
    const sentToBoox = (saved: Saved | undefined) => saved?.cloud?.state === "sent" && (saved.cloud.turnedAt ?? 0) >= saved.updatedAt

    let lastTurn = { key: "", at: 0 }
    const snapshot = (): Snapshot | undefined => {
      const b = book()
      if (!b) return undefined
      const turnedAt = Math.max(store.books[b.key]?.updatedAt ?? 0, lastTurn.key === b.key ? lastTurn.at : 0)
      return { book: b, position: position(), percent: percent(), finished: finished(), turnedAt }
    }
    const setCloud = (key: string, cloud: Saved["cloud"]) =>
      void setStore((draft) => {
        const saved = draft.books[key]
        if (!saved) return
        if (cloud) saved.cloud = cloud
        else delete saved.cloud
      }).catch(() => {})

    /**
     * What the cloud acknowledged per book: the page-turn time of the snapshot
     * it holds, and the update time our push wrote. Kept in memory too, as
     * store writes land asynchronously.
     */
    const acked = new Map<string, Partial<OwnPush>>()
    const ackOf = (key: string): Partial<OwnPush> | undefined => {
      const cloud = store.books[key]?.cloud
      return acked.get(key) ?? (cloud ? { turnedAt: cloud.turnedAt, pushedAt: cloud.pushedAt } : undefined)
    }
    const acknowledge = (key: string, ack: Partial<OwnPush>) => {
      acked.set(key, ack)
      setCloud(key, { state: "sent", at: Date.now(), ...ack })
    }

    /** Sends one snapshot, when it was reached here by turning pages after the Boox's last save. */
    const pushOnce = async (key: string, s: Snapshot) => {
      if (!s.book.booxPath || !s.turnedAt) return
      const ack = ackOf(key)
      if ((ack?.turnedAt ?? 0) >= s.turnedAt) return // This reading is already in the cloud.
      if (!(await settings())?.cloud) return
      const own = ack?.pushedAt !== undefined && ack.turnedAt !== undefined ? { pushedAt: ack.pushedAt, turnedAt: ack.turnedAt } : undefined
      const result = (await reader
        .push({ path: s.book.path, booxPath: s.book.booxPath, spine: s.position.spine, offset: s.position.offset, percent: s.percent, finished: s.finished, turnedAt: s.turnedAt, ...(own ? { own } : {}) })
        .catch((e) => ({ ok: false, state: "error", error: failure(e) }))) as PushResult
      if (!result.ok) {
        noteCloud(result.state, result.error)
        // The cloud still holds the last acknowledged push.
        if (result.state !== "off") setCloud(key, { state: "failed", at: Date.now(), ...(ack ?? {}) })
        return
      }
      setCloudState("ok")
      // Acknowledge the snapshot that was sent, not whatever was read meanwhile.
      if (result.pushed) acknowledge(key, { turnedAt: s.turnedAt, pushedAt: result.at })
      else if (result.reason === "same position") acknowledge(key, { turnedAt: s.turnedAt, ...(ack?.pushedAt !== undefined ? { pushedAt: ack.pushedAt } : {}) })
    }
    const queuePush = pushQueue<Snapshot>(pushOnce)
    /** Pushes per book run one at a time; the latest snapshot offered meanwhile goes next. */
    const syncPush = (s: Snapshot | undefined) => (s?.book.booxPath && s.turnedAt ? queuePush(s.book.key, s) : Promise.resolve())
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

    /** Opens at the cloud position when the Boox read the book more recently (once a minute per book at most). */
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
      const result = (await reader.pull({ path: b.path, booxPath: b.booxPath }).catch((e) => ({ ok: false, state: "error", error: failure(e) }))) as PullResult
      if (!result.ok) {
        noteCloud(result.state, result.error)
        return
      }
      setCloudState("ok")
      const c = result.cloud
      if (c.percent !== undefined)
        void setStore((draft) => void (draft.books[b.key] && (draft.books[b.key].boox = { percent: c.percent!, lastAccess: c.lastAccess, checkedAt: Date.now() }))).catch(() => {})
      // The reader moved meanwhile: their move wins.
      if (book()?.key !== b.key || position() !== before) return
      const saved = store.books[b.key]
      const remote = c.spine !== undefined && c.offset !== undefined && c.spine < b.chapters.length ? { spine: c.spine, offset: c.offset } : undefined
      const pull = {
        turnedAt: saved?.updatedAt,
        updateTime: c.updateTime,
        lastAccess: c.lastAccess,
        ...(c.deviceModel ? { deviceModel: c.deviceModel } : {}),
        ...(ackOf(b.key)?.pushedAt !== undefined ? { pushedAt: ackOf(b.key)!.pushedAt } : {}),
        local: before,
        cloud: remote,
      }
      if (!decidePull(pull)) return
      await goTo(remote!, false)
      flush()
      acked.set(b.key, {}) // The cloud now holds the Boox's position, not ours.
      setCloud(b.key, undefined)
      toast(`Opened at the Boox position (${pct(percent())}).`, "success")
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
      turnedAt = undefined
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
      const summary = `${downloaded} downloaded, ${onBoox} only on the Boox${failed.length ? `; failed: ${failed.map((b) => b.title).join(", ")}` : ""}`
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

    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      flush()
      disposePanel()
      disposeSidebar()
    }
  },
})
