/**
 * Books on disk: the local folder, the cache of copies pulled from the Boox,
 * per-book metadata and the chapter index (characters per spine document).
 * One chapter is decoded at a time; nothing keeps a whole book in memory.
 */
import { createHash, randomBytes } from "node:crypto"
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, join, posix, relative, resolve, sep } from "node:path"
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

/** Decodes each chapter once, keeping only its length and first heading. */
export function buildIndex(path: string): BookIndex {
  return withZip(path, (zip) => {
    const pkg = readPackage(zip, fallback(path))
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

export type AddedBook = { path: string; key: string; title: string }
/** `existing`: the copy already in the folder, for an "already there" book. */
export type AddResult = { added: AddedBook[]; skipped: Array<{ name: string; reason: string; existing?: AddedBook }> }

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
 * Copies `file` into `dir` under `name`, or `name (2)`, `(3)`…: a 0600 temp
 * file in `dir`, written whole and flushed, then published by `publishCopy`.
 * Returns the new path.
 */
function copyInto(file: string, dir: string, name: string): string {
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.epub.tmp`)
  const out = openSync(temp, "wx", 0o600)
  try {
    try {
      const source = openSync(file, "r")
      try {
        const buffer = Buffer.alloc(1024 * 1024)
        for (;;) {
          const n = readSync(source, buffer, 0, buffer.length, null)
          if (n === 0) break
          for (let done = 0; done < n; ) done += writeSync(out, buffer, done, n - done)
        }
      } finally {
        closeSync(source)
      }
      fsyncSync(out)
    } finally {
      closeSync(out)
    }
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return publishCopy(temp, dir, name)
}

/**
 * Copies the EPUB at `source`, or the EPUBs of a folder (three levels deep, as
 * `scanEpubs`), into `dir` (created when missing). A book is added only when
 * it opens as a book does for reading (no DRM, same limits). Nothing is ever
 * overwritten: a book identical to one in `dir` (size and content), or a
 * source already in `dir`, is "already there"; another book of the same
 * name gets a " (2)" suffix.
 */
export function addBooks(source: string, dir: string): AddResult {
  const result: AddResult = { added: [], skipped: [] }
  let files: string[]
  try {
    files = statSync(source).isDirectory() ? scanEpubs(source) : [source]
  } catch {
    result.skipped.push({ name: basename(source), reason: "not found" })
    return result
  }
  // Books of `dir` by size, hashed only when a candidate has the same size.
  let bySize: Map<number, string[]> | undefined
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
  for (const file of files) {
    const name = basename(file)
    const skip = (reason: string, existing?: AddedBook) => void result.skipped.push({ name, reason, ...(existing ? { existing } : {}) })
    if (!/\.epub$/i.test(name)) {
      skip("not an EPUB")
      continue
    }
    let size: number
    try {
      const stat = statSync(file)
      if (!stat.isFile()) {
        skip("not an EPUB")
        continue
      }
      size = stat.size
    } catch {
      skip("unreadable")
      continue
    }
    if (size > MAX_ADD_FILE) {
      skip("too large")
      continue
    }
    let title: string
    try {
      title = buildIndex(file).title
    } catch (error) {
      skip(refusal(error))
      continue
    }
    if (within(file, [dir])) {
      // Named as the library lists it.
      const inside = join(dir, relative(realpathSync(dir), realpathSync(file)))
      skip(ALREADY_THERE, { path: inside, key: bookKey({ file: inside }), title })
      continue
    }
    try {
      if (!bySize) {
        mkdirSync(dir, { recursive: true })
        bySize = new Map()
        for (const path of scanEpubs(dir)) {
          try {
            const s = statSync(path).size
            bySize.set(s, [...(bySize.get(s) ?? []), path])
          } catch {
            // Gone meanwhile.
          }
        }
      }
      const same = (bySize.get(size) ?? []).find((path) => hashOf(path) === hashOf(file))
      if (same) {
        skip(ALREADY_THERE, known(same))
        continue
      }
      // A hidden name would not be listed.
      const target = name.replace(/^\.+/, "")
      const dest = copyInto(file, dir, /\.epub$/i.test(target) && target.length > 5 ? target : "book.epub")
      bySize.set(size, [...(bySize.get(size) ?? []), dest])
      hashes.set(dest, hashOf(file))
      result.added.push({ path: dest, key: bookKey({ file: dest }), title })
    } catch (error) {
      skip((error as Error).message === NO_HARD_LINKS ? NO_HARD_LINKS : `copy failed (${(error as NodeJS.ErrnoException).code ?? "error"})`)
    }
  }
  return result
}
