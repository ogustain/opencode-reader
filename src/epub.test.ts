import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateRawSync } from "node:zlib"
import { bufferSource, decodeXml, EpubError, MAX_BOOK_INFLATE, MAX_CENTRAL_DIRECTORY, MAX_ENTRY, openZip, readPackage, type ByteSource } from "./epub.ts"
import { bookKey, buildIndex, cacheFile, neoRefs, readChapter, readChapterMap, readMeta, scanEpubs, within } from "./library.ts"

/** Builds a ZIP in memory: stored or deflated entries, central directory, EOCD. */
/** `size` / `compressed` override the sizes declared in the central directory (malformed archives). */
function zip(
  files: Array<{ name: string; data: string | Buffer; store?: boolean; flags?: number; size?: number; compressed?: number }>,
): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8")
    const body = file.store ? raw : deflateRawSync(raw)
    const name = Buffer.from(file.name, "utf8")
    const flags = (file.flags ?? 0) | 0x0800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(file.store ? 0 : 8, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(flags, 8)
    entry.writeUInt16LE(file.store ? 0 : 8, 10)
    entry.writeUInt32LE(crc32(raw), 16)
    entry.writeUInt32LE(file.compressed ?? body.length, 20)
    entry.writeUInt32LE(file.size ?? raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title id="t">Le Petit Livre d&#8217;essai</dc:title>
    <dc:creator>Émile Testeur</dc:creator>
  </metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="img/a.png" media-type="image/png"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="cover"/><itemref idref="c1"/><itemref idref="css"/><itemref idref="c2"/></spine>
</package>`

const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="n1" playOrder="1"><navLabel><text>Chapitre premier</text></navLabel><content src="text/ch1.xhtml#start"/></navPoint>
  <navPoint id="n2" playOrder="2"><navLabel><text>Suite</text></navLabel><content src="text/ch1.xhtml#later"/></navPoint>
</navMap></ncx>`

const chapter = (title: string, body: string) =>
  `<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head><body><h1>${title}</h1>${body}</body></html>`

function sampleEpub(extra: Array<{ name: string; data: string }> = []): Buffer {
  return zip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/cover.xhtml", data: chapter("", `<img src="img/a.png"/>`).replace("<h1></h1>", "") },
    { name: "OEBPS/text/ch1.xhtml", data: chapter("One", "<p>First paragraph.</p><p>Second &amp; last.</p>"), store: true },
    { name: "OEBPS/text/ch 2.xhtml", data: chapter("Two", "<p>" + "word ".repeat(200) + "</p>") },
    { name: "OEBPS/style.css", data: "p{}" },
    { name: "OEBPS/toc.ncx", data: ncx },
    ...extra,
  ])
}

test("reads stored and deflated entries", () => {
  const archive = openZip(bufferSource(sampleEpub()))
  assert.equal(archive.read("mimetype").toString(), "application/epub+zip")
  assert.match(archive.read("OEBPS/text/ch 2.xhtml").toString(), /<h1>Two<\/h1>/)
  assert.ok(archive.names.includes("OEBPS/style.css"))
  assert.throws(() => archive.read("nope"), EpubError)
})

test("parses the OPF: title, author, spine order of content documents", () => {
  const pkg = readPackage(openZip(bufferSource(sampleEpub())))
  assert.equal(pkg.title, "Le Petit Livre d’essai")
  assert.equal(pkg.author, "Émile Testeur")
  assert.deepEqual(pkg.spine, ["OEBPS/cover.xhtml", "OEBPS/text/ch1.xhtml", "OEBPS/text/ch 2.xhtml"])
})

test("chapter titles come from the NCX or the EPUB 3 nav document", () => {
  assert.deepEqual(readPackage(openZip(bufferSource(sampleEpub()))).toc, { "OEBPS/text/ch1.xhtml": "Chapitre premier" })
  const nav = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks"><a href="ch1.xhtml">Skip</a></nav>
    <nav epub:type="toc"><ol><li><a href="ch1.xhtml">Un <em>début</em></a></li><li><a href="ch%202.xhtml#x">Deux</a></li></ol></nav></body></html>`
  const withNav = zip(
    [
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf.replace("</manifest>", `<item id="nav" href="text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>`) },
      { name: "OEBPS/text/nav.xhtml", data: nav },
      { name: "OEBPS/cover.xhtml", data: "<html><body/></html>" },
      { name: "OEBPS/text/ch1.xhtml", data: chapter("One", "<p>x</p>") },
      { name: "OEBPS/text/ch 2.xhtml", data: chapter("Two", "<p>y</p>") },
    ],
  )
  assert.deepEqual(readPackage(openZip(bufferSource(withNav))).toc, { "OEBPS/text/ch1.xhtml": "Un début", "OEBPS/text/ch 2.xhtml": "Deux" })
})

test("rejects archives that are not EPUBs or are protected", () => {
  assert.throws(() => openZip(bufferSource(Buffer.from("hello world, not a zip at all"))), /not a ZIP/)
  assert.throws(() => readPackage(openZip(bufferSource(zip([{ name: "a.txt", data: "x" }])))), /not an EPUB/)
  const drm = `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData></EncryptedData></encryption>`
  assert.throws(() => readPackage(openZip(bufferSource(sampleEpub([{ name: "META-INF/encryption.xml", data: drm }])))), /protected book/)
  assert.throws(() => readPackage(openZip(bufferSource(sampleEpub([{ name: "META-INF/rights.xml", data: "<rights/>" }])))), /protected book/)
  const encrypted = zip([{ name: "META-INF/container.xml", data: container, flags: 1 }])
  assert.throws(() => readPackage(openZip(bufferSource(encrypted))), /protected book/)
})

test("obfuscated fonts are not DRM", () => {
  const fonts = `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>`
  assert.equal(readPackage(openZip(bufferSource(sampleEpub([{ name: "META-INF/encryption.xml", data: fonts }])))).spine.length, 3)
})

/** Wraps a source and records the largest read. */
function recording(source: ByteSource) {
  const stats = { largest: 0 }
  return {
    stats,
    source: { ...source, read: (position: number, length: number) => ((stats.largest = Math.max(stats.largest, length)), source.read(position, length)) },
  }
}

test("declared and actual entry sizes are bounded before and after reading", () => {
  const lyingStored = openZip(bufferSource(zip([{ name: "a", data: "0123456789", store: true, size: 1 }])))
  assert.throws(() => lyingStored.read("a"), /corrupt ZIP entry/)
  const lyingDeflated = openZip(bufferSource(zip([{ name: "a", data: "x".repeat(100_000), size: 1 }])))
  assert.throws(() => lyingDeflated.read("a"), /corrupt compressed entry/)
  const shortDeflated = openZip(bufferSource(zip([{ name: "a", data: "x".repeat(100), size: 200 }])))
  assert.throws(() => shortDeflated.read("a"), /corrupt compressed entry/)
  const huge = recording(bufferSource(zip([{ name: "a", data: "0123456789", store: true, size: 1, compressed: MAX_ENTRY + 1 }])))
  assert.throws(() => openZip(huge.source).read("a"), /too large/)
  assert.ok(huge.stats.largest < 1024, `read ${huge.stats.largest} bytes`)
})

test("an oversized central directory is refused without reading it", () => {
  const size = 600 * 1024 * 1024
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(size - 22 - 64, 12)
  end.writeUInt32LE(64, 16)
  const synthetic: ByteSource = {
    size,
    read: (position, length) => {
      const out = Buffer.alloc(length)
      if (position + length === size) end.copy(out, length - 22)
      return out
    },
    close() {},
  }
  const probe = recording(synthetic)
  assert.throws(() => openZip(probe.source), /central directory is too large/)
  assert.ok(probe.stats.largest <= MAX_CENTRAL_DIRECTORY, `read ${probe.stats.largest} bytes`)
})

test("reading an invalid book does not leak file descriptors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reader-fd-"))
  const bad = join(dir, "bad.epub")
  await writeFile(bad, "not a zip at all")
  const open = () => readdirSync("/dev/fd").length
  const before = open()
  for (let i = 0; i < 20; i++) assert.throws(() => readMeta(bad), EpubError)
  assert.equal(open(), before)
})

test("truncated archives fail clearly", () => {
  const data = sampleEpub()
  assert.throws(() => openZip(bufferSource(data.subarray(0, data.length - 40))), EpubError)
})

test("library: index with chapter lengths and headings, one chapter at a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-reader-"))
  const path = join(dir, "sub", "book.epub")
  await mkdir(join(dir, "sub"))
  await writeFile(path, sampleEpub())
  await writeFile(join(dir, "notes.txt"), "x")
  assert.deepEqual(scanEpubs(dir), [path])
  assert.equal(readMeta(path).title, "Le Petit Livre d’essai")
  const index = buildIndex(path)
  assert.equal(index.chapters.length, 3)
  assert.equal(index.chapters[0].chars, 0)
  assert.equal(index.chapters[1].title, "Chapitre premier")
  assert.equal(index.chapters[2].title, "Two")
  assert.equal(index.chapters[1].chars, "One".length + 1 + "First paragraph.".length + 1 + "Second & last.".length + 1)
  assert.deepEqual(readChapter(path, 1)[1], { text: "First paragraph." })
  // NeoReader's spine keeps every itemref (here a stylesheet) and counts UTF-8 bytes.
  const bytes = (name: string) => Buffer.byteLength(openZip(bufferSource(sampleEpub())).read(name))
  const [cover, ch1, css, ch2] = ["OEBPS/cover.xhtml", "OEBPS/text/ch1.xhtml", "OEBPS/style.css", "OEBPS/text/ch 2.xhtml"].map(bytes)
  assert.deepEqual(neoRefs(path), [
    { id: "cover", spine: 0, start: 0, end: cover },
    { id: "c1", spine: 1, start: cover, end: cover + ch1 },
    { id: "css", spine: -1, start: cover + ch1, end: cover + ch1 + css },
    { id: "c2", spine: 2, start: cover + ch1 + css, end: cover + ch1 + css + ch2 },
  ])
  assert.deepEqual(readChapterMap(path, 1).paragraphs, readChapter(path, 1))
  assert.ok(within(path, [dir]))
  assert.ok(!within("/etc/passwd", [dir]))
  assert.ok(!within(`${dir}-other/x.epub`, [dir]))
})

test("library: keys and cache names are stable and path-safe", () => {
  assert.equal(bookKey({ booxPath: "/storage/emulated/0/Books/a.epub" }), bookKey({ booxPath: "/storage/emulated/0/Books/a.epub" }))
  assert.notEqual(bookKey({ booxPath: "/x/a.epub" }), bookKey({ file: "/x/a.epub" }))
  const file = cacheFile("/cache", "/storage/emulated/0/Books/L’été d'un \"homme\"/x.epub", 10)
  assert.match(file, /^\/cache\/[0-9a-f]{16}-x\.epub$/)
  assert.notEqual(cacheFile("/cache", "/b/x.epub", 10), cacheFile("/cache", "/b/x.epub", 11))
  assert.match(cacheFile("/c", "/b/L’été: vol 2?.epub", 1), /-L_été_ vol 2_\.epub$/)
})

test("a book's decompressed bytes are budgeted across entries, before inflating", () => {
  const archive = openZip(bufferSource(zip([{ name: "a", data: "x".repeat(600) }, { name: "b", data: "y".repeat(600) }])), { budget: 1000 })
  assert.equal(archive.read("a").length, 600)
  assert.throws(() => archive.read("b"), /too large once decompressed/)
  assert.throws(() => archive.read("a"), /too large once decompressed/) // Reading again counts again.
})

test("a spine repeating one large chapter is decoded once, within the budget", async () => {
  const big = chapter("Big", "<p>" + "word ".repeat(220_000) + "</p>") // About 1.1 MB, deflates to a few KB.
  const repeats = Math.ceil(MAX_BOOK_INFLATE / Buffer.byteLength(big)) + 10
  const repeatedOpf = opf.replace(/<spine[\s\S]*<\/spine>/, `<spine>${'<itemref idref="c1"/>'.repeat(repeats)}</spine>`)
  const dir = await mkdtemp(join(tmpdir(), "reader-spine-"))
  const path = join(dir, "repeat.epub")
  const data = zip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: repeatedOpf },
    { name: "OEBPS/text/ch1.xhtml", data: big },
  ])
  assert.ok(data.length < 64 * 1024, `${data.length} bytes`)
  await writeFile(path, data)
  const index = buildIndex(path)
  assert.equal(index.chapters.length, repeats)
  assert.ok(index.chapters.every((c) => c.chars === index.chapters[0].chars && c.chars > 1_000_000))
  const refs = neoRefs(path)
  assert.equal(refs.length, repeats)
  assert.equal(refs.at(-1)!.end, repeats * Buffer.byteLength(big))
})

test("reads are confined to the folders once symbolic links are resolved", async () => {
  const base = await mkdtemp(join(tmpdir(), "reader-roots-"))
  const books = join(base, "books")
  const outside = join(base, "outside")
  await mkdir(books)
  await mkdir(outside)
  await writeFile(join(books, "in.epub"), "PK")
  await writeFile(join(outside, "secret.epub"), "PK")
  await symlink(join(outside, "secret.epub"), join(books, "link.epub"))
  await symlink(outside, join(books, "linked-dir"))
  assert.ok(within(join(books, "in.epub"), [books]))
  assert.ok(!within(join(books, "link.epub"), [books]))
  assert.ok(!within(join(books, "linked-dir", "secret.epub"), [books]))
  assert.ok(!within(join(books, "..", "outside", "secret.epub"), [books]))
  assert.ok(!within(join(books, "missing.epub"), [books]))
  // A folder that is itself a link (books kept elsewhere) still holds its books.
  await symlink(books, join(base, "alias"))
  assert.ok(within(join(base, "alias", "in.epub"), [join(base, "alias")]))
  assert.ok(within(join(books, "in.epub"), [join(base, "alias")]))
})

test("documents are decoded by byte order mark or XML declaration: UTF-8 and UTF-16 only", async () => {
  const text = '<?xml version="1.0" encoding="UTF-16"?><html><body><p>Élan — 東京</p></body></html>'
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
  const be = Buffer.from(le)
  be.swap16()
  assert.equal(decodeXml(le, "a.xhtml"), text)
  assert.equal(decodeXml(be, "a.xhtml"), text)
  assert.equal(decodeXml(Buffer.from(text, "utf16le"), "a.xhtml"), text) // No mark.
  // UTF-8 decodes exactly as before, mark included (positions count it).
  const utf8 = Buffer.from('\ufeff<?xml version="1.0" encoding="utf-8"?><p>Élan</p>', "utf8")
  assert.equal(decodeXml(utf8, "a.xhtml"), utf8.toString("utf8"))
  assert.equal(decodeXml(Buffer.from("<p>Élan</p>"), "a.xhtml"), "<p>Élan</p>")
  assert.throws(() => decodeXml(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><p>\xe9</p>', "latin1"), "OEBPS/a.xhtml"), {
    name: "Error",
    message: 'OEBPS/a.xhtml: unsupported text encoding "iso-8859-1" (only UTF-8 and UTF-16)',
  })

  // A UTF-16LE chapter in a book reads like any other.
  const dir = await mkdtemp(join(tmpdir(), "opencode-reader-"))
  const path = join(dir, "utf16.epub")
  const chapter16 = '<?xml version="1.0" encoding="UTF-16"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Un</h1><p>Première page — 東京.</p></body></html>'
  const opf16 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Seize</dc:title></metadata>
    <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`
  await writeFile(
    path,
    zip([
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf16 },
      { name: "OEBPS/c1.xhtml", data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(chapter16, "utf16le")]) },
    ]),
  )
  assert.equal(readMeta(path).title, "Seize")
  assert.deepEqual(readChapter(path, 0), [{ text: "Un", heading: true }, { text: "Première page — 東京." }])
  assert.equal(buildIndex(path).chapters[0].title, "Un")
  assert.deepEqual(readChapterMap(path, 0).paragraphs, readChapter(path, 0))
})
