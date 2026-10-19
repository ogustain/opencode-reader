/**
 * Minimal EPUB access: a ZIP reader on `node:zlib` (central directory, stored
 * and deflated entries) and the OPF package (title, author, spine order).
 *
 * Entries are read on demand with positional reads, so a 50 MB book with
 * images costs only the chapter being read. ZIP64, multi-disk archives and
 * encrypted entries are rejected with a clear error.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { posix } from "node:path"
import { inflateRawSync } from "node:zlib"
import { attributes, decodeEntities } from "./text.ts"

export class EpubError extends Error {}

/** Positional byte source: a file descriptor or an in-memory buffer (tests). */
export type ByteSource = {
  readonly size: number
  read(position: number, length: number): Buffer
  close(): void
}

export function bufferSource(data: Buffer): ByteSource {
  return { size: data.length, read: (position, length) => data.subarray(position, position + length), close() {} }
}

export function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r")
  const size = fstatSync(fd).size
  return {
    size,
    read(position, length) {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)))
      let done = 0
      while (done < buffer.length) {
        const n = readSync(fd, buffer, done, buffer.length - done, position + done)
        if (n === 0) break
        done += n
      }
      return buffer.subarray(0, done)
    },
    close: () => closeSync(fd),
  }
}

type Entry = { name: string; method: number; flags: number; compressed: number; size: number; offset: number }

/** Largest entry we read or inflate: guards against ZIP bombs. */
export const MAX_ENTRY = 64 * 1024 * 1024
/** Largest central directory we read (65535 entries with long names fit). */
export const MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024
/** Bytes read or inflated per opened book, all entries together (repeated reads count again). */
export const MAX_BOOK_INFLATE = 256 * 1024 * 1024

export type Zip = {
  readonly names: string[]
  has(name: string): boolean
  read(name: string): Buffer
  close(): void
}

export function openZip(source: ByteSource, options: { budget?: number } = {}): Zip {
  let budget = options.budget ?? MAX_BOOK_INFLATE
  const tailLength = Math.min(source.size, 22 + 0xffff)
  const tail = source.read(source.size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new EpubError("not a ZIP archive (no end of central directory)")
  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new EpubError("multi-disk ZIP not supported")
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new EpubError("ZIP64 archives are not supported")
  if (cdSize > MAX_CENTRAL_DIRECTORY) throw new EpubError("ZIP central directory is too large")
  if (cdOffset + cdSize > source.size) throw new EpubError("truncated ZIP archive")

  const cd = source.read(cdOffset, cdSize)
  const entries = new Map<string, Entry>()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new EpubError("corrupt ZIP central directory")
    const nameLength = cd.readUInt16LE(p + 28)
    const name = cd.subarray(p + 46, p + 46 + nameLength).toString("utf8")
    entries.set(name, {
      name,
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      compressed: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    })
    p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name)
      if (!entry) throw new EpubError(`missing ${name}`)
      if (entry.flags & 1) throw new EpubError("encrypted ZIP entries: protected book, not supported")
      // Declared sizes are checked before any read; the actual size after inflating too.
      if (entry.size > MAX_ENTRY || entry.compressed > MAX_ENTRY) throw new EpubError(`${name} is too large`)
      if (entry.method === 0 && entry.compressed !== entry.size) throw new EpubError(`corrupt ZIP entry ${name}`)
      // The declared size is checked after inflating, so it bounds the book's total too.
      if (entry.size > budget) throw new EpubError("book too large once decompressed (over 256 MiB read)")
      budget -= entry.size
      const header = source.read(entry.offset, 30)
      if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new EpubError(`corrupt ZIP entry ${name}`)
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      const data = source.read(start, entry.compressed)
      if (data.length < entry.compressed) throw new EpubError(`truncated ZIP entry ${name}`)
      if (entry.method === 0) return data
      if (entry.method === 8) {
        let inflated: Buffer
        try {
          inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
        } catch {
          throw new EpubError(`corrupt compressed entry ${name}`)
        }
        if (inflated.length !== entry.size) throw new EpubError(`corrupt compressed entry ${name}`)
        return inflated
      }
      throw new EpubError(`unsupported ZIP compression method ${entry.method}`)
    },
    close: () => source.close(),
  }
}

export type Package = {
  title: string
  author?: string
  /** Archive paths of the spine documents, in reading order. */
  spine: string[]
  /** Table-of-contents label of a spine document, when the book has one. */
  toc: Record<string, string>
  /** Every `<itemref>` in order: idref, archive path, index in `spine` (-1 when not readable). */
  refs: Array<{ id: string; href?: string; spine: number }>
}

const CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html", "application/x-dtbook+xml"])
/** Font obfuscation is not DRM: such books stay readable. */
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"])

function tags(xml: string, local: string): Array<Record<string, string>> {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}\\b([^>]*)>`, "g")
  return [...xml.matchAll(re)].map((m) => attributes(m[1]))
}

function element(xml: string, local: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`).exec(xml)
  if (!m) return undefined
  const text = decodeEntities(m[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim()
  return text || undefined
}

function resolveHref(base: string, href: string): string {
  let path = href.split("#")[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    // Keep the raw href.
  }
  return posix.normalize(posix.join(base, path)).replace(/^\.\//, "")
}

/**
 * Text of an XML or XHTML document, by its byte order mark, else the
 * encoding of its XML declaration. UTF-8 (the default) decodes exactly as
 * before; UTF-16 LE/BE through TextDecoder; any other encoding is refused.
 */
export function decodeXml(bytes: Buffer, name: string): string {
  const [a, b, c, d] = bytes
  if (a === 0xff && b === 0xfe) return new TextDecoder("utf-16le").decode(bytes)
  if (a === 0xfe && b === 0xff) return new TextDecoder("utf-16be").decode(bytes)
  // No mark: `<?` in UTF-16 (XML 1.0, appendix F).
  if (a === 0x3c && b === 0 && c === 0x3f && d === 0) return new TextDecoder("utf-16le").decode(bytes)
  if (a === 0 && b === 0x3c && c === 0 && d === 0x3f) return new TextDecoder("utf-16be").decode(bytes)
  const head = bytes.subarray(0, 256).toString("latin1")
  const declared = /^(?:\u00ef\u00bb\u00bf)?\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']*)["']/.exec(head)?.[1].trim().toLowerCase()
  if (!declared || declared === "utf-8" || declared === "utf8" || declared === "us-ascii" || declared === "ascii") return bytes.toString("utf8")
  throw new EpubError(`${name}: unsupported text encoding "${declared.slice(0, 40)}" (only UTF-8 and UTF-16)`)
}

/** DRM check: Adobe ADEPT rights, or encrypted entries other than obfuscated fonts. */
function assertNotProtected(zip: Zip) {
  if (zip.has("META-INF/rights.xml")) throw new EpubError("protected book (DRM), not supported")
  if (!zip.has("META-INF/encryption.xml")) return
  const xml = decodeXml(zip.read("META-INF/encryption.xml"), "META-INF/encryption.xml")
  const blocks = xml.split(/<(?:[\w-]+:)?EncryptedData\b/).slice(1)
  for (const block of blocks) {
    const algorithm = tags(block, "EncryptionMethod")[0]?.Algorithm ?? ""
    const uri = tags(block, "CipherReference")[0]?.URI ?? ""
    const font = /\.(otf|ttf|woff2?)$/i.test(uri)
    if (!(font && FONT_OBFUSCATION.has(algorithm))) throw new EpubError("protected book (DRM), not supported")
  }
}

/** Reads container.xml then the OPF: metadata and spine order. */
export function readPackage(zip: Zip, fallbackTitle = "Untitled"): Package {
  if (!zip.has("META-INF/container.xml")) throw new EpubError("not an EPUB (no META-INF/container.xml)")
  assertNotProtected(zip)
  const container = decodeXml(zip.read("META-INF/container.xml"), "META-INF/container.xml")
  const rootfile = tags(container, "rootfile").find((r) => r["full-path"])
  if (!rootfile) throw new EpubError("not an EPUB (no rootfile in container.xml)")
  const opfPath = rootfile["full-path"]
  const opf = decodeXml(zip.read(opfPath), opfPath)
  const base = posix.dirname(opfPath) === "." ? "" : posix.dirname(opfPath)

  const manifest = new Map<string, { href: string; type: string; properties: string }>()
  for (const item of tags(opf, "item")) {
    if (item.id && item.href)
      manifest.set(item.id, { href: resolveHref(base, item.href), type: item["media-type"] ?? "", properties: item.properties ?? "" })
  }
  const spine: string[] = []
  const refs: Package["refs"] = []
  for (const ref of tags(opf, "itemref")) {
    const item = ref.idref ? manifest.get(ref.idref) : undefined
    const readable = !!item && CONTENT_TYPES.has(item.type) && zip.has(item.href)
    refs.push({ id: ref.idref ?? "", ...(item ? { href: item.href } : {}), spine: readable ? spine.length : -1 })
    if (readable) spine.push(item.href)
  }
  if (spine.length === 0) throw new EpubError("EPUB has no readable chapters")
  const ncxId = tags(opf, "spine")[0]?.toc
  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"))
  const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml")
  let toc: Record<string, string> = {}
  try {
    if (nav && zip.has(nav.href)) toc = navTitles(decodeXml(zip.read(nav.href), nav.href), posix.dirname(nav.href))
    if (Object.keys(toc).length === 0 && ncx && zip.has(ncx.href)) toc = ncxTitles(decodeXml(zip.read(ncx.href), ncx.href), posix.dirname(ncx.href))
  } catch {
    toc = {} // Chapter titles are optional.
  }
  return { title: element(opf, "title") ?? fallbackTitle, author: element(opf, "creator"), spine, toc, refs }
}

const label = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()

function addTitle(toc: Record<string, string>, base: string, href: string | undefined, text: string) {
  if (!href || !text) return
  const doc = resolveHref(base === "." ? "" : base, href)
  toc[doc] ??= text
}

/** EPUB 3 navigation document: the first link to each document in the `toc` nav. */
function navTitles(xhtml: string, base: string): Record<string, string> {
  const section = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml)?.[1] ?? xhtml
  const toc: Record<string, string> = {}
  for (const m of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) addTitle(toc, base, attributes(m[1]).href, label(m[2]))
  return toc
}

/** EPUB 2 NCX: the first navPoint pointing at each document. */
function ncxTitles(xml: string, base: string): Record<string, string> {
  const toc: Record<string, string> = {}
  const p = "(?:[\\w-]+:)?"
  const re = new RegExp(`<${p}navLabel\\b[^>]*>\\s*<${p}text\\b[^>]*>([\\s\\S]*?)</${p}text>[\\s\\S]*?<${p}content\\b([^>]*)>`, "g")
  for (const m of xml.matchAll(re)) addTitle(toc, base, attributes(m[2]).src, label(m[1]))
  return toc
}
