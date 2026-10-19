/**
 * Server half of the opencode-reader plugin.
 *
 * Owns every file, device and network access, so the TUI works against a
 * remote server too: lists the local EPUB folder (`dir`, default ~/Books) and
 * the cache of books copied from the Boox, serves book indexes and one chapter
 * at a time, reads the NeoReader library over ADB (read-only, at most once a
 * minute, used to copy files), and syncs reading positions with the Onyx cloud
 * (library at most once a minute; one book doc GET per pull, GET + PUT per push).
 * A book file not on this computer is downloaded from the Onyx cloud storage when
 * the Boox uploaded it, else copied over ADB.
 *
 * Options: `dir` (local books), `dataDir` (cache, token, session, backups;
 * default `$XDG_DATA_HOME/opencode-reader`), `adb` (adb binary), `serial`
 * (device serial when several are attached), `server` ("eur" or "us"),
 * `tokenFile` (Onyx token), `pushIdleMinutes` (push after this long without a
 * page turn).
 */
import { Plugin } from "@opencode/plugin"
import { resolve } from "node:path"
import { createAdb, type BooxBook } from "./adb.ts"
import {
  bookKey, buildIndex, cacheFile, defaultCacheDir, expandHome, fileStamp, neoRefs, readChapter, readChapterMap, readMeta, scanEpubs,
  within, type BookIndex,
} from "./library.ts"
import type { ChapterMap } from "./neoposition.ts"
import { defaultDataDir } from "./paths.ts"
import { createFetcher, createLock, liveCopies, type CacheManifest } from "./sources.ts"
import {
  createOnyx, defaultBackupFile, defaultSessionFile, defaultSyncFile, defaultTokenFile, OnyxError, readMarks, saveBackup, updateMark, type CloudDoc,
  type OnyxState,
} from "./onyx.ts"
import {
  ReaderRpc, type BookEntry, type BooxListing, type ChapterResult, type CloudListing, type FetchResult, type OpenResult, type PullResult,
  type PushResult,
} from "./rpc.ts"
import {
  cloudLibrary, pullDoc, pushDoc, toLocal, toNeo, validMark, withPushedProgress, type CloudLibrary, type DocIo, type LocalReading, type NeoRef,
} from "./sync.ts"

const BOOX_MIN_INTERVAL_MS = 60_000
const CLOUD_MIN_INTERVAL_MS = 60_000

type Json = Parameters<Plugin.Context["storage"]["set"]>[1]

/** The local reading sent by the TUI: `gen`, `turnedAt` and an optional `receipt`; undefined when invalid. */
function readingOf(input: Record<string, unknown>): LocalReading | undefined {
  const { spine, offset, percent, finished, turnedAt } = input
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0
  if (!valid(spine) || !valid(offset) || !valid(percent) || !valid(turnedAt)) return undefined
  return { position: { spine, offset }, percent, finished: finished === true, turnedAt }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const stateOf = (error: unknown): OnyxState => (error instanceof OnyxError ? error.state : "error")
type CloudCache = { state: OnyxState; message: string; checkedAt?: number } & CloudLibrary

export default Plugin.define({
  id: "opencode-reader",
  async setup(ctx) {
    const dir = resolve(expandHome(typeof ctx.options.dir === "string" && ctx.options.dir ? ctx.options.dir : "~/Books"))
    const dataDir = typeof ctx.options.dataDir === "string" && ctx.options.dataDir ? resolve(expandHome(ctx.options.dataDir)) : defaultDataDir()
    const cacheDir = defaultCacheDir(dataDir)
    const roots = [dir, cacheDir]
    const adb = createAdb({ bin: ctx.options.adb, serial: ctx.options.serial })
    const onyx = createOnyx({
      server: ctx.options.server,
      tokenFile:
        typeof ctx.options.tokenFile === "string" && ctx.options.tokenFile ? resolve(expandHome(ctx.options.tokenFile)) : defaultTokenFile(dataDir),
      sessionFile: defaultSessionFile(dataDir),
    })
    const idle = Number(ctx.options.pushIdleMinutes)
    const pushIdleMinutes = Number.isFinite(idle) && idle > 0 ? idle : 5

    const load = async <T>(key: string): Promise<T | undefined> => {
      try {
        return (await ctx.storage.get(key)) as T | undefined
      } catch {
        return undefined
      }
    }
    const save = async (key: string, value: unknown) => {
      try {
        await ctx.storage.set(key, value as Json)
      } catch {
        // Best effort cache.
      }
    }

    const metas = new Map<string, { stamp: string; title: string; author?: string }>()
    const entry = (path: string, manifest: CacheManifest): BookEntry | undefined => {
      try {
        const stamp = fileStamp(path)
        let meta = metas.get(path)
        if (meta?.stamp !== stamp) {
          meta = { stamp, ...readMeta(path) }
          metas.set(path, meta)
        }
        const boox = manifest[resolve(path)]
        return {
          key: boox ? bookKey({ booxPath: boox.booxPath }) : bookKey({ file: path }),
          path,
          title: meta.title,
          ...(meta.author ? { author: meta.author } : {}),
          source: boox ? "boox" : "local",
          ...(boox ? { booxPath: boox.booxPath } : {}),
        }
      } catch {
        return undefined // Unreadable or protected: not listed.
      }
    }

    // Book files: the cached copy, else the cloud copy (downloaded beside the file), else ADB.
    const manifestLock = createLock()
    /** The cache manifest, without (and pruned of) the copies deleted since. */
    const cacheManifest = async (): Promise<CacheManifest> => {
      const manifest = (await load<CacheManifest>("cache")) ?? {}
      const live = liveCopies(manifest)
      if (Object.keys(live).length === Object.keys(manifest).length) return live
      return manifestLock(async () => {
        const current = liveCopies((await load<CacheManifest>("cache")) ?? {})
        await save("cache", current)
        return current
      })
    }

    let listing: BooxListing = (await load<BooxListing>("boox")) ?? { state: "none", message: "Boox not checked yet", books: [] }
    let lastAsked = 0
    let asking: Promise<BooxListing> | undefined
    const askBoox = async (): Promise<BooxListing> => {
      lastAsked = Date.now()
      const manifest = await cacheManifest()
      const cachedBy = new Map(Object.entries(manifest).map(([file, m]) => [`${m.booxPath}:${m.size}`, file]))
      try {
        const books = await adb.listBooks()
        listing = {
          state: "ok",
          message: "Boox connected",
          checkedAt: Date.now(),
          books: books.map((b: BooxBook) => {
            const cached = cachedBy.get(`${b.path}:${b.size}`)
            return { ...b, key: bookKey({ booxPath: b.path }), ...(cached ? { cached } : {}) }
          }),
        }
        await save("boox", listing)
      } catch (error) {
        const state = (error as { state?: BooxListing["state"] }).state ?? "error"
        // Keep the last known books (and their %) for the hint, flagged with the failure.
        listing = { ...listing, state, message: message(error) }
      }
      return listing
    }

    // Onyx cloud library (books, collections): asked at most once a minute, last result kept.
    let cloud: CloudCache = (await load<CloudCache>("cloud")) ?? { state: "off", message: "Onyx cloud not checked yet", collections: [], books: [] }
    let lastCloud = 0
    let cloudAsking: Promise<CloudCache> | undefined
    const askCloud = (): Promise<CloudCache> =>
      (cloudAsking ??= (async () => {
        lastCloud = Date.now()
        try {
          cloud = { state: "ok", message: "", checkedAt: Date.now(), ...cloudLibrary(await onyx.library()) }
          await save("cloud", cloud)
        } catch (error) {
          cloud = { ...cloud, state: stateOf(error), message: message(error) }
        }
        return cloud
      })().finally(() => (cloudAsking = undefined)))
    /** Doc id of the cloud book at a Boox path; the library is fetched again when it is not known. */
    const cloudBook = async (booxPath: string) => {
      const find = () => cloud.books.find((b) => b.path === booxPath)
      if (!find() && Date.now() - lastCloud >= CLOUD_MIN_INTERVAL_MS) await askCloud()
      if (!find() && cloud.state !== "ok") throw new OnyxError(cloud.state, cloud.message)
      return find()
    }

    // Spine byte ranges per file version, and the last few chapter maps.
    const refs = new Map<string, NeoRef[]>()
    const maps = new Map<string, ChapterMap>()
    const refsOf = (path: string) => {
      const key = fileStamp(path)
      if (!refs.has(key)) refs.set(key, neoRefs(path))
      return refs.get(key)!
    }
    const mapOf = (path: string, spine: number) => {
      const key = `${fileStamp(path)}:${spine}`
      let map = maps.get(key)
      if (!map) {
        map = readChapterMap(path, spine)
        maps.set(key, map)
        while (maps.size > 3) maps.delete(maps.keys().next().value!)
      }
      return map
    }
    const backupFile = defaultBackupFile(dataDir)
    // Per book doc: the last agreement and our writes, recorded before each PUT (see `CloudMark`).
    const syncFile = defaultSyncFile(dataDir)
    /** A book doc's cloud, sync record and positions, for `pullDoc` and `pushDoc`. */
    const docIo = (id: string, path: string): DocIo => ({
      getDoc: () => onyx.getDoc(id),
      putDoc: (doc) => onyx.putDoc(doc as CloudDoc),
      isConflict: (error) => stateOf(error) === "conflict",
      mark: () => validMark(readMarks(syncFile)[id]),
      setMark: (mark) => void updateMark(syncFile, id, () => mark),
      backup: (doc, now) => saveBackup(backupFile, doc as CloudDoc, now),
      toLocal: (point) => toLocal(point, refsOf(path), (spine) => mapOf(path, spine)),
      toNeo: (local) => toNeo(local, refsOf(path), mapOf(path, local.spine)),
      now: () => Date.now(),
    })
    // Pushes of one book doc run one at a time (several windows may push it).
    const docLocks = new Map<string, ReturnType<typeof createLock>>()
    const docLock = (id: string) => docLocks.get(id) ?? docLocks.set(id, createLock()).get(id)!
    const fetchFile = createFetcher({
      cloud: () =>
        onyx.configured()
          ? async (booxPath, file, size) => {
              const book = await cloudBook(booxPath)
              if (!book) throw new OnyxError("missing", "book not in the Onyx cloud")
              await onyx.downloadBook(await onyx.getDoc(book.id), file, size)
            }
          : undefined,
      pull: (booxPath, local) => adb.pull(booxPath, local),
    })

    const registration = await ctx.rpc.register(ReaderRpc, {
      library: async () => {
        const manifest = await cacheManifest()
        const files = [...scanEpubs(dir), ...Object.keys(manifest).filter((file) => within(file, [cacheDir]))]
        const books = files.map((path) => entry(path, manifest)).filter((b): b is BookEntry => !!b)
        return { dir, books }
      },
      boox: async (input) => {
        const refresh = (input as { refresh?: boolean } | undefined)?.refresh === true
        if (!refresh || Date.now() - lastAsked < BOOX_MIN_INTERVAL_MS) return asking ?? listing
        asking ??= askBoox().finally(() => (asking = undefined))
        return asking
      },
      fetch: async (input): Promise<FetchResult> => {
        const { booxPath, size, cloud: useCloud } = (input ?? {}) as { booxPath?: string; size?: number; cloud?: boolean }
        if (typeof booxPath !== "string" || !/\.epub$/i.test(booxPath) || typeof size !== "number")
          return { ok: false, error: "invalid book" }
        const file = cacheFile(cacheDir, booxPath, size)
        try {
          const obtained = await fetchFile(booxPath, file, size, { cloud: useCloud !== false })
          const expired = obtained.expired ? ({ expired: true } as const) : {}
          if (!obtained.ok) return { ok: false, error: obtained.error, ...(obtained.notHere ? { notHere: true } : {}), ...expired }
          const source = obtained.source
          // Downloads last minutes: read the manifest afresh, one writer at a time.
          const manifest = await manifestLock(async () => {
            const current = (await load<CacheManifest>("cache")) ?? {}
            current[resolve(file)] = { booxPath, size }
            await save("cache", current)
            return current
          })
          const book = entry(file, manifest)
          if (!book) {
            try {
              readMeta(file)
            } catch (error) {
              return { ok: false, error: message(error) }
            }
            return { ok: false, error: "unreadable book" }
          }
          return { ok: true, book, source, ...expired }
        } catch (error) {
          return { ok: false, error: message(error) }
        }
      },
      open: async (input): Promise<OpenResult> => {
        const path = (input as { path?: string } | undefined)?.path
        if (typeof path !== "string" || !within(path, roots)) return { ok: false, error: "book outside the reader folders" }
        try {
          const key = `index-${fileStamp(path)}`
          let index = await load<BookIndex>(key)
          if (!index || !Array.isArray(index.chapters)) {
            index = buildIndex(path)
            await save(key, index)
          }
          return { ok: true, ...index }
        } catch (error) {
          return { ok: false, error: message(error) }
        }
      },
      settings: async () => ({ cloud: onyx.configured(), pushIdleMinutes }),
      cloud: async (input): Promise<CloudListing> => {
        const refresh = (input as { refresh?: boolean } | undefined)?.refresh === true
        if (refresh && Date.now() - lastCloud >= CLOUD_MIN_INTERVAL_MS) await askCloud()
        else if (cloudAsking) await cloudAsking
        if (!onyx.configured()) cloud = { ...cloud, state: "off", message: "Onyx cloud not configured (see README)" }
        const manifest = await cacheManifest()
        const cachedBy = new Map(Object.entries(manifest).map(([file, m]) => [`${m.booxPath}:${m.size}`, file]))
        const books = cloud.books.map((b) => {
          const cached = cachedBy.get(`${b.path}:${b.size}`)
          return { ...b, key: bookKey({ booxPath: b.path }), ...(cached ? { cached } : {}) }
        })
        return { ...cloud, books }
      },
      pull: async (input): Promise<PullResult> => {
        const { path, booxPath, ...rest } = (input ?? {}) as Record<string, unknown>
        if (typeof path !== "string" || !within(path, roots) || typeof booxPath !== "string") return { ok: false, state: "error", error: "invalid book" }
        const local = readingOf(rest)
        if (!local) return { ok: false, state: "error", error: "invalid position" }
        try {
          const book = await cloudBook(booxPath)
          if (!book) return { ok: false, state: "error", error: "book not in the Onyx cloud (sync off for it?)" }
          return { ok: true, cloud: await pullDoc(docIo(book.id, path), local) }
        } catch (error) {
          return { ok: false, state: stateOf(error), error: message(error) }
        }
      },
      agree: async (input) => {
        const { booxPath, rev, print, turnedAt } = (input ?? {}) as Record<string, unknown>
        const base = validMark({ base: { rev, print, localAt: turnedAt } }).base
        if (typeof booxPath !== "string" || !base) return { ok: false }
        try {
          const book = await cloudBook(booxPath)
          if (book) updateMark(syncFile, book.id, () => ({ base }))
          return { ok: !!book }
        } catch {
          return { ok: false }
        }
      },
      push: async (input): Promise<PushResult> => {
        const { path, booxPath, force, ...rest } = (input ?? {}) as Record<string, unknown>
        if (typeof path !== "string" || !within(path, roots) || typeof booxPath !== "string") return { ok: false, state: "error", error: "invalid book" }
        const local = readingOf(rest)
        if (!local) return { ok: false, state: "error", error: "invalid position" }
        try {
          const book = await cloudBook(booxPath)
          if (!book) return { ok: false, state: "error", error: "book not in the Onyx cloud (sync off for it?)" }
          // A position is only meaningful in the same file as the Boox's.
          const copy = ((await load<CacheManifest>("cache")) ?? {})[resolve(path)]
          if (!copy || copy.booxPath !== booxPath || (book.size > 0 && copy.size !== book.size))
            return { ok: false, state: "error", error: "the local copy is not the Boox file" }
          const result = await docLock(book.id)(() => pushDoc(docIo(book.id, path), local, force === true))
          if (!result.pushed) return { ok: true, ...result }
          // The cached listing shows the new %, and hides a book finished here, before the next library read.
          cloud = { ...cloud, books: withPushedProgress(cloud.books, book.id, result.progress) }
          await save("cloud", cloud)
          return { ok: true, pushed: true, at: result.at, agreedAt: result.agreedAt }
        } catch (error) {
          return { ok: false, state: stateOf(error), error: message(error) }
        }
      },
      chapter: async (input): Promise<ChapterResult> => {
        const { path, spine } = (input ?? {}) as { path?: string; spine?: number }
        if (typeof path !== "string" || !within(path, roots)) return { ok: false, error: "book outside the reader folders" }
        if (typeof spine !== "number" || !Number.isInteger(spine) || spine < 0) return { ok: false, error: "invalid chapter" }
        try {
          return { ok: true, paragraphs: readChapter(path, spine) }
        } catch (error) {
          return { ok: false, error: message(error) }
        }
      },
    })

    return () => {
      void registration.dispose()
    }
  },
})
