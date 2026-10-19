/**
 * Books on disk: the local folder, the cache of copies pulled from the Boox,
 * per-book metadata and the chapter index (characters per spine document).
 * One chapter is decoded at a time; nothing keeps a whole book in memory.
 */
import { createHash } from "node:crypto"
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { fileSource, openZip, readPackage, type Zip } from "./epub.ts"
import { mapChapter, type ChapterMap } from "./neoposition.ts"
import { defaultDataDir } from "./paths.ts"
import type { NeoRef } from "./sync.ts"
import { chapterLength, xhtmlToParagraphs, type Paragraph } from "./text.ts"

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
      const paragraphs = xhtmlToParagraphs(zip.read(doc).toString("utf8"))
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
    return mapChapter(zip.read(doc).toString("utf8"))
  })
}

export function readChapter(path: string, spine: number): Paragraph[] {
  return withZip(path, (zip) => {
    const pkg = readPackage(zip, fallback(path))
    const doc = pkg.spine[spine]
    if (!doc) throw new Error(`no chapter ${spine}`)
    return xhtmlToParagraphs(zip.read(doc).toString("utf8"))
  })
}
