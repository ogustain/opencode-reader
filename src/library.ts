/**
 * Books on disk: the reader's library (the books added are moved there), the
 * local folder, the cache of copies pulled from the Boox,
 * per-book metadata and the chapter index (characters per spine document).
 * One chapter is decoded at a time; nothing keeps a whole book in memory.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeSync,
  type Dirent, type Stats,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path"
import { decodeXml, fileSource, openZip, readPackage, resolveHref, type Zip } from "./epub.ts"
import { mapChapter, type ChapterMap } from "./neoposition.ts"
import { defaultDataDir } from "./paths.ts"
import type { NeoRef } from "./sync.ts"
import { chapterLength, noteText, xhtmlToParagraphs, type Paragraph } from "./text.ts"

export type BookIndex = { title: string; author?: string; chapters: Array<{ title?: string; chars: number }> }

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

export const defaultCacheDir = (dataDir = defaultDataDir()) => join(dataDir, "books")
/** The reader's own library: the books added are moved there. */
export const defaultLibraryDir = (dataDir = defaultDataDir()) => join(dataDir, "library")

/**
 * The book files listed: the reader's library, then `dir` (when it exists;
 * never created), then the Boox copies of the cache. A file seen twice is
 * listed once.
 */
export function libraryFiles(libraryDir: string, dir: string, cached: readonly string[]): string[] {
  return [...new Set([...scanEpubs(libraryDir), ...scanEpubs(dir), ...cached])]
}

const hash = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 16)

/** Storage key of a book: its Boox path for Boox copies, its file path otherwise. */
export function bookKey(source: { booxPath: string } | { file: string }): string {
  return "booxPath" in source ? `boox-${hash(source.booxPath)}` : `file-${hash(resolve(source.file))}`
}

/** Cache file for a Boox book: one per Boox path and size, readable name kept. */
export function cacheFile(cacheDir: string, booxPath: string, size: number): string {
  const name = basename(booxPath).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(-80)
  return join(cacheDir, `${hash(`${booxPath}:${size}`)}-${name}`)
}

/** `.epub` files under `dir`, three levels deep at most. */
export function scanEpubs(dir: string, depth = 3): string[] {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 1) out.push(...scanEpubs(path, depth - 1))
    else if (entry.isFile() && /\.epub$/i.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * True when `path` is inside one of `roots` once symbolic links are resolved
 * (book reads are limited to known folders); false when it does not exist.
 */
export function within(path: string, roots: readonly string[]): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return undefined
    }
  }
  const full = real(path)
  return !!full && roots.some((root) => {
    const top = real(root)
    return !!top && full.startsWith(top + sep)
  })
}

/** Identity of a file version, for caching its metadata and index. */
export function fileStamp(path: string): string {
  const s = statSync(path)
  return hash(`${resolve(path)}:${s.size}:${s.mtimeMs}`)
}

function withZip<T>(path: string, use: (zip: Zip) => T): T {
  // The source is closed even when openZip rejects the file.
  const source = fileSource(path)
  try {
    return use(openZip(source))
  } finally {
    source.close()
  }
}

const fallback = (path: string) => basename(path).replace(/\.epub$/i, "")

export function readMeta(path: string): { title: string; author?: string } {
  return withZip(path, (zip) => {
    const pkg = readPackage(zip, fallback(path))
    return { title: pkg.title, ...(pkg.author ? { author: pkg.author } : {}) }
  })
}

/**
 * Decodes each chapter once, keeping only its length and first heading.
 * `name`: the title of a book without one (its file name by default).
 */
export function buildIndex(path: string, name = fallback(path)): BookIndex {
  return withZip(path, (zip) => {
    const pkg = readPackage(zip, name)
    // A document the spine repeats is decoded once.
    const seen = new Map<string, BookIndex["chapters"][number]>()
    const chapters = pkg.spine.map((doc) => {
      const known = seen.get(doc)
      if (known) return known
      const paragraphs = xhtmlToParagraphs(decodeXml(zip.read(doc), doc))
      const heading = pkg.toc[doc] ?? paragraphs.find((p) => p.heading)?.text.replace(/\s+/g, " ")
      const chapter = { ...(heading ? { title: heading.slice(0, 80) } : {}), chars: paragraphs.length ? chapterLength(paragraphs) : 0 }
      seen.set(doc, chapter)
      return chapter
    })
    return { title: pkg.title, ...(pkg.author ? { author: pkg.author } : {}), chapters }
  })
}

/** NeoReader's view of the spine: each itemref with its byte range in the concatenated documents. */
export function neoRefs(path: string): NeoRef[] {
  return withZip(path, (zip) => {
    let start = 0
    const sizes = new Map<string, number>() // A document the spine repeats is inflated once.
    const size = (href: string) => sizes.get(href) ?? sizes.set(href, zip.read(href).length).get(href)!
    return readPackage(zip, fallback(path)).refs.map((ref) => {
      const bytes = ref.href && zip.has(ref.href) ? size(ref.href) : 0
      const out = { id: ref.id, spine: ref.spine, start, end: start + bytes }
      start += bytes
      return out
    })
  })
}

/** Text nodes of a chapter aligned with its paragraphs, for NeoReader positions. */
export function readChapterMap(path: string, spine: number): ChapterMap {
  return withZip(path, (zip) => {
    const doc = readPackage(zip, fallback(path)).spine[spine]
    if (!doc) throw new Error(`no chapter ${spine}`)
    return mapChapter(decodeXml(zip.read(doc), doc))
  })
}

export function readChapter(path: string, spine: number): Paragraph[] {
  return withZip(path, (zip) => {
    const pkg = readPackage(zip, fallback(path))
    const doc = pkg.spine[spine]
    if (!doc) throw new Error(`no chapter ${spine}`)
    const paragraphs = xhtmlToParagraphs(decodeXml(zip.read(doc), doc))
    // Note targets as archive paths (`file#id`), for `readNote`.
    const dir = posix.dirname(doc) === "." ? "" : posix.dirname(doc)
    for (const p of paragraphs)
      for (const n of p.notes ?? []) n.href = n.href.startsWith("#") ? doc + n.href : resolveHref(dir, n.href) + n.href.slice(n.href.indexOf("#"))
    return paragraphs
  })
}

/** Longest note text returned (characters). */
export const MAX_NOTE = 8000

/** Text of the note at `href` (`file#id`, an archive path), capped at `MAX_NOTE`. Throws when it is not in the book. */
export function readNote(path: string, href: string): string {
  const hash = href.indexOf("#")
  const file = posix.normalize(href.slice(0, Math.max(0, hash)))
  let id = href.slice(hash + 1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // Keep the raw id.
  }
  if (hash < 0 || !id) throw new Error("not a note link")
  if (file === ".." || file.startsWith("../") || posix.isAbsolute(file)) throw new Error("note outside the book")
  return withZip(path, (zip) => {
    readPackage(zip, fallback(path)) // A protected book is refused here too.
    if (!zip.has(file)) throw new Error(`note file not in the book: ${file}`)
    const text = noteText(decodeXml(zip.read(file), file), id)
    if (text === undefined) throw new Error(`note #${id} not found`)
    return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}…` : text
  })
}

/** Largest book file added, as for the cloud and ADB copies. */
export const MAX_ADD_FILE = 512 * 1024 * 1024
export const ALREADY_THERE = "already there"
/** A source identical to a book of the library, removed once checked: "already in the library (removed from Downloads)". */
export const ALREADY_IN_LIBRARY = "already in the library"
/** Most books read by one add; the others are skipped with `TOO_MANY`. */
export const MAX_ADD_BOOKS = 500
export const TOO_MANY = "too many files: add a smaller folder"

export type AddedBook = { path: string; key: string; title: string }
/**
 * `added`: the books now in the library; `kept`: the original was kept, and
 * why (else it was moved). `existing`: the copy already in the library or
 * `dir`, for a book already there.
 */
export type AddResult = {
  added: Array<AddedBook & { kept?: string }>
  skipped: Array<{ name: string; reason: string; existing?: AddedBook }>
}

/** The reason shown for a book that does not open. */
function refusal(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/protected/.test(text)) return "protected (DRM)"
  if (/too large/.test(text)) return "too large"
  if (/not a ZIP|not an EPUB|no readable chapters/.test(text)) return "not an EPUB"
  return "unreadable"
}

/** SHA-256 of a file's content, read in chunks. */
function contentHash(path: string): string {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null)
      if (n === 0) break
      hash.update(buffer.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}

/** Refusal of a file system without hard links: a free name cannot be taken without a risk of replacing a file. */
export const NO_HARD_LINKS = "can't copy safely on this filesystem"

/**
 * Links the finished `temp` (in `dir`) to `name`, or `name (2)`, `(3)`…: the
 * link never replaces a file. `temp` is removed in every case. Returns the new
 * path; throws `NO_HARD_LINKS` on a file system without hard links.
 */
export function publishCopy(temp: string, dir: string, name: string, link: (from: string, to: string) => void = linkSync): string {
  try {
    const stem = name.replace(/\.epub$/i, "")
    for (let n = 1; ; n++) {
      const dest = join(dir, n === 1 ? name : `${stem} (${n}).epub`)
      try {
        link(temp, dest)
        return dest
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST") continue
        if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EMLINK" || code === "EOPNOTSUPP") throw new Error(NO_HARD_LINKS)
        throw error
      }
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Copies the open file `source` into a new 0600 temp file in `dir`, written
 * whole and flushed, counting the bytes: past `limit` it stops with "too
 * large". The temp file is removed on any failure. Returns it with its size.
 */
export function copyToTemp(source: number, dir: string, limit = MAX_ADD_FILE): { temp: string; size: number } {
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.epub.tmp`)
  const out = openSync(temp, "wx", 0o600)
  let size = 0
  try {
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      for (;;) {
        const n = readSync(source, buffer, 0, buffer.length, null)
        if (n === 0) break
        size += n
        if (size > limit) throw new Error("too large")
        for (let done = 0; done < n; ) done += writeSync(out, buffer, done, n - done)
      }
      fsyncSync(out)
    } finally {
      closeSync(out)
    }
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return { temp, size }
}

/** Flushes a folder's entries (a new link) to disk; skipped where a folder cannot be flushed. */
function syncDir(dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, "r")
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // Some platforms refuse to flush a folder.
  } finally {
    closeSync(fd)
  }
}

/** Removing an added book's source: `unlink` and a hook run just before the last check (tests). */
export type MoveIo = { unlink?: (path: string) => void; beforeRemove?: (path: string) => void }

/**
 * Removes `file`, the source of a book now in the library as `copy` (the
 * copy published, or the identical book found there), only when every check
 * holds; else keeps it and returns why. `copy` must be a file of `size` bytes
 * whose content hashes to `hash`, read again here. Then, just before the
 * unlink, the path `file` must still be a regular file (not a symbolic link)
 * and the very file read: same device, inode, size, modification and change
 * times as `origin` (the `fstat` of the descriptor the copy was read from).
 * Never removes a folder.
 */
export function removeSource(file: string, origin: Stats, copy: { path: string; size: number; hash: string }, io: MoveIo = {}): string | undefined {
  try {
    const stat = lstatSync(copy.path)
    if (!stat.isFile() || stat.size !== copy.size || contentHash(copy.path) !== copy.hash) return "copy not verified"
  } catch {
    return "copy not verified"
  }
  io.beforeRemove?.(file)
  let now: Stats
  try {
    now = lstatSync(file)
  } catch {
    return "changed meanwhile"
  }
  if (now.isSymbolicLink()) return "symbolic link"
  if (!now.isFile()) return "not a file"
  const same =
    now.dev === origin.dev && now.ino === origin.ino && now.size === origin.size && now.mtimeMs === origin.mtimeMs && now.ctimeMs === origin.ctimeMs
  if (!same) return "changed meanwhile"
  try {
    ;(io.unlink ?? unlinkSync)(file)
  } catch (error) {
    return `cannot remove: ${(error as NodeJS.ErrnoException).code ?? "error"}`
  }
  return undefined
}

/**
 * Moves the EPUB at `source`, or the EPUBs of a folder (three levels deep, as
 * `scanEpubs`), into the reader's `library` folder (created 0700 when
 * missing). `dir` and `cacheDir` are only read, never created.
 *
 * Each file is read once, through one descriptor, into a 0600 temp file in
 * the library; that copy is what is checked (it opens as a book does for
 * reading: no DRM, same limits), hashed and published under a free name
 * (never replacing a file). Only then is the source removed, by
 * `removeSource`, and only when it is a regular file, not a symbolic link,
 * unchanged since it was read and the published copy verifies; else it is
 * kept and `kept` says why. Folders are never removed.
 *
 * A source inside the library, `dir` or the cache is "already there" and never
 * touched. A book identical (size, then content) to one of the library or
 * `dir` is not copied again: its source is removed under the same checks. At
 * most `MAX_ADD_BOOKS` files are read; the event loop runs between two
 * books, so other requests are served meanwhile.
 */
export async function addBooks(source: string, folders: { library: string; dir: string; cacheDir: string }, io: MoveIo = {}): Promise<AddResult> {
  const { library, dir, cacheDir } = folders
  const result: AddResult = { added: [], skipped: [] }
  let files: string[]
  try {
    files = statSync(source).isDirectory() ? scanEpubs(source) : [source]
  } catch {
    result.skipped.push({ name: basename(source), reason: "not found" })
    return result
  }
  for (const file of files.slice(MAX_ADD_BOOKS)) result.skipped.push({ name: basename(file), reason: TOO_MANY })
  files = files.slice(0, MAX_ADD_BOOKS)
  // Books of the library and `dir` by size (read at the first copy), hashed only when a candidate has the same size.
  const bySize = new Map<number, string[]>()
  let scanned = false
  const hashes = new Map<string, string>()
  const hashOf = (path: string) => hashes.get(path) ?? hashes.set(path, contentHash(path)).get(path)!
  const known = (path: string): AddedBook => {
    let title = fallback(path)
    try {
      title = readMeta(path).title
    } catch {
      // Listed under its file name.
    }
    return { path, key: bookKey({ file: path }), title }
  }
  for (const [i, file] of files.entries()) {
    if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    const name = basename(file)
    const skip = (reason: string, existing?: AddedBook) => void result.skipped.push({ name, reason, ...(existing ? { existing } : {}) })
    if (!/\.epub$/i.test(name)) {
      skip("not an EPUB")
      continue
    }
    // Already a book of the reader: never copied, never removed.
    const home = [library, dir].find((root) => within(file, [root]))
    if (home) {
      // Named as the library lists it.
      skip(ALREADY_THERE, known(join(home, relative(realpathSync(home), realpathSync(file)))))
      continue
    }
    if (within(file, [cacheDir])) {
      skip(ALREADY_THERE)
      continue
    }
    // The path itself: a symbolic link is copied, never removed.
    let link: boolean
    try {
      link = lstatSync(file).isSymbolicLink()
    } catch {
      skip("not found")
      continue
    }
    // One descriptor, the link followed: what is checked is what is read. A FIFO does not block the open.
    let fd: number
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch {
      skip("unreadable")
      continue
    }
    let origin: Stats
    let copy: { temp: string; size: number }
    try {
      origin = fstatSync(fd)
      if (!origin.isFile()) {
        skip("not an EPUB")
        continue
      }
      if (origin.size > MAX_ADD_FILE) {
        skip("too large")
        continue
      }
      if (!scanned) {
        mkdirSync(library, { recursive: true, mode: 0o700 })
        for (const path of [...scanEpubs(library), ...scanEpubs(dir)]) {
          try {
            const s = statSync(path).size
            bySize.set(s, [...(bySize.get(s) ?? []), path])
          } catch {
            // Gone meanwhile.
          }
        }
        scanned = true
      }
      copy = copyToTemp(fd, library)
    } catch (error) {
      skip((error as Error).message === "too large" ? "too large" : `copy failed (${(error as NodeJS.ErrnoException).code ?? "error"})`)
      continue
    } finally {
      closeSync(fd)
    }
    const { temp, size } = copy
    /** Removes the source of a book now in the library at `path`; why it was kept otherwise. */
    const remove = (path: string, hash: string): string | undefined => {
      if (link) return "symbolic link"
      if (size !== origin.size) return "changed meanwhile"
      return removeSource(file, origin, { path, size, hash }, io)
    }
    try {
      let title: string
      try {
        title = buildIndex(temp, fallback(file)).title
      } catch (error) {
        skip(refusal(error))
        continue
      }
      const hash = hashOf(temp)
      const same = (bySize.get(size) ?? []).find((path) => hashOf(path) === hash)
      if (same) {
        const kept = remove(same, hash)
        skip(kept ? ALREADY_THERE : `${ALREADY_IN_LIBRARY} (removed from ${basename(dirname(file))})`, known(same))
        continue
      }
      // A hidden name would not be listed.
      const target = name.replace(/^\.+/, "")
      const dest = publishCopy(temp, library, /\.epub$/i.test(target) && target.length > 5 ? target : "book.epub")
      syncDir(library) // The new name is on disk before the source goes.
      bySize.set(size, [...(bySize.get(size) ?? []), dest])
      hashes.set(dest, hash)
      const kept = remove(dest, hash)
      result.added.push({ path: dest, key: bookKey({ file: dest }), title, ...(kept ? { kept } : {}) })
    } catch (error) {
      skip((error as Error).message === NO_HARD_LINKS ? NO_HARD_LINKS : `copy failed (${(error as NodeJS.ErrnoException).code ?? "error"})`)
    } finally {
      rmSync(temp, { force: true })
      hashes.delete(temp)
    }
  }
  return result
}
