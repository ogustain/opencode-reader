import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AdbError } from "./adb.ts"
import { createOnyx, EXPIRED_MESSAGE, OnyxError, publishFile } from "./onyx.ts"
import { createFetcher, createLock, liveCopies, NOT_HERE, obtainBook } from "./sources.ts"

const fail = (error: Error) => async () => {
  throw error
}
const noBoox = new AdbError("none", "No Boox connected")

test("the cloud copy comes first, ADB next, and a missing or unreachable cloud falls through quietly", async () => {
  let pulled = 0
  const adb = async () => void pulled++
  assert.deepEqual(await obtainBook({ cloud: async () => {}, adb }), { ok: true, source: "cloud" })
  assert.equal(pulled, 0)
  for (const state of ["missing", "offline", "off", "error"] as const)
    assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError(state, "x")), adb }), { ok: true, source: "adb" }, state)
  assert.deepEqual(await obtainBook({ adb }), { ok: true, source: "adb" })
  assert.equal(pulled, 5)
})

test("with no source left: the upload hint, the expired-token message, or the ADB failure", async () => {
  assert.match(NOT_HERE, /^Not on this computer: /)
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("missing", "x")), adb: fail(noBoox) }), { ok: false, error: NOT_HERE, notHere: true })
  assert.deepEqual(await obtainBook({ adb: fail(new AdbError("offline", "offline")) }), { ok: false, error: NOT_HERE, notHere: true })
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("expired", EXPIRED_MESSAGE)), adb: fail(noBoox) }), { ok: false, error: EXPIRED_MESSAGE, expired: true })
  const bad = await obtainBook({ cloud: fail(new OnyxError("error", "the cloud file is not an EPUB")), adb: fail(noBoox) })
  assert.deepEqual(bad, { ok: false, error: "the cloud file is not an EPUB" })
  // A cloud that may have the file but cannot give it is not "not uploaded".
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("error", "Onyx cloud: HTTP 503")), adb: fail(noBoox) }), { ok: false, error: "Onyx cloud: HTTP 503" })
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("offline", "Onyx cloud unreachable")), adb: fail(noBoox) }), {
    ok: false,
    error: "offline: Onyx cloud unreachable",
  })
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("off", "x")), adb: fail(noBoox) }), { ok: false, error: NOT_HERE, notHere: true })
  assert.deepEqual(await obtainBook({ cloud: fail(new OnyxError("missing", "x")), adb: fail(new AdbError("unauthorized", "Allow USB debugging on the Boox")) }), {
    ok: false,
    error: "Allow USB debugging on the Boox",
  })
})

test("a book file the cloud storage does not have (404) falls back to ADB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sources-"))
  const tokenFile = join(dir, "token")
  writeFileSync(tokenFile, "header.payload.signature")
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  const onyx = createOnyx({
    tokenFile,
    sessionFile: join(dir, "session"),
    now: () => Date.parse("2026-10-17T12:00:00Z"),
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("users/syncToken")) return reply({ result_code: 0, data: { cookie_name: "C", session_id: "s1", expires: "2026-11-04T00:00:00Z" } })
      if (url.endsWith("_session")) return reply({ userCtx: { name: "u1" } })
      if (url.endsWith("config/stss"))
        return reply({ result_code: 0, data: { AccessKeyId: "id", AccessKeySecret: "secret", SecurityToken: "sts", Expiration: "2026-10-17T12:15:00Z" } })
      if (url.endsWith("config/buckets")) return reply({ result_code: 0, data: { "onyx-cloud": { bucket: "onyx-cloud-us", aliEndpoint: "oss-us-west-1.aliyuncs.com" } } })
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    }) as typeof fetch,
  })
  const file = join(dir, "book.epub")
  const doc = { _id: "u1#b1", modeType: 4, uniqueId: "b1", type: "epub", fileOriginSize: 4 }
  const result = await obtainBook({ cloud: () => onyx.downloadBook(doc, file, 4), adb: async () => writeFileSync(file, "PK..") })
  assert.deepEqual(result, { ok: true, source: "adb" })
  assert.ok(existsSync(file))
})

// ---------------------------------------------------------------------------
// Fetching into the cache

const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}
const BOOK = Buffer.from("PK\x03\x04 a book file")

test("concurrent fetches of one book share a single download, and the cache is checked again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-"))
  const file = join(dir, "book.epub")
  let downloads = 0
  const wait = gate()
  const fetchFile = createFetcher({
    cloud: () => async (_path, dest) => {
      downloads++
      await wait.opened
      const temp = `${dest}.t`
      writeFileSync(temp, BOOK)
      publishFile(temp, dest, BOOK.length)
    },
    pull: async () => assert.fail("no ADB when the cloud has it"),
  })
  const first = fetchFile("/b.epub", file, BOOK.length)
  const second = fetchFile("/b.epub", file, BOOK.length)
  wait.open()
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true, source: "cloud" }, { ok: true, source: "cloud" }])
  assert.equal(downloads, 1)
  assert.deepEqual(await fetchFile("/b.epub", file, BOOK.length), { ok: true, source: "cache" })
  assert.equal(downloads, 1)
})

test("concurrent ADB copies use their own temp files and keep a valid published copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-"))
  const pulls: string[] = []
  const wait = gate()
  const fetchFile = createFetcher({
    cloud: () => undefined,
    pull: async (_path, local) => {
      pulls.push(local)
      await wait.opened
      writeFileSync(local, BOOK)
    },
  })
  // Two books at once: distinct temp names, both published, no temp left.
  const a = fetchFile("/a.epub", join(dir, "a.epub"), BOOK.length)
  const b = fetchFile("/b.epub", join(dir, "b.epub"), BOOK.length)
  wait.open()
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true, source: "adb" }, { ok: true, source: "adb" }])
  assert.equal(new Set(pulls).size, 2)
  assert.deepEqual(readdirSync(dir).sort(), ["a.epub", "b.epub"])

  // A valid copy published meanwhile (another process) stays; an invalid one is replaced.
  const dest = join(dir, "c.epub")
  writeFileSync(dest, Buffer.alloc(BOOK.length, 1))
  writeFileSync(`${dest}.t`, BOOK)
  publishFile(`${dest}.t`, dest, BOOK.length)
  assert.ok(readFileSync(dest).equals(Buffer.alloc(BOOK.length, 1)))
  writeFileSync(dest, "short")
  writeFileSync(`${dest}.t`, BOOK)
  publishFile(`${dest}.t`, dest, BOOK.length)
  assert.ok(readFileSync(dest).equals(BOOK))
  assert.deepEqual(readdirSync(dir).sort(), ["a.epub", "b.epub", "c.epub"])
})

test("manifest updates after parallel downloads keep every entry", async () => {
  // An async store, as the plugin storage: reads and writes take a turn of the event loop.
  let stored: Record<string, number> = {}
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
  const load = async () => (await tick(), { ...stored })
  const save = async (value: Record<string, number>) => (await tick(), (stored = value))
  const record = (key: string) => async () => {
    const current = await load()
    current[key] = 1
    await save(current)
  }
  // Without the lock one entry is lost: the race the lock removes.
  await Promise.all([record("a")(), record("b")()])
  assert.equal(Object.keys(stored).length, 1)

  stored = {}
  const lock = createLock()
  const failing = lock(async () => {
    throw new Error("storage error")
  })
  await Promise.all([lock(record("a")), lock(record("b")), lock(record("c")), failing.catch(() => {})])
  assert.deepEqual(Object.keys(stored).sort(), ["a", "b", "c"])
  await assert.rejects(failing, /storage error/)
})

test("a failed or short ADB copy leaves no temp file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-"))
  const broken = createFetcher({
    cloud: () => undefined,
    pull: async (_path, local) => {
      writeFileSync(local, BOOK.subarray(0, 5))
      throw new Error("adb: connection reset")
    },
  })
  assert.deepEqual(await broken("/a.epub", join(dir, "a.epub"), BOOK.length), { ok: false, error: "adb: connection reset" })
  const short = createFetcher({ cloud: () => undefined, pull: async (_path, local) => writeFileSync(local, BOOK.subarray(0, 5)) })
  assert.deepEqual(await short("/a.epub", join(dir, "a.epub"), BOOK.length), { ok: false, error: `incomplete copy (5 of ${BOOK.length} bytes)` })
  assert.deepEqual(readdirSync(dir), [])
})

test("a refused token is reported as such even when ADB copies the book, and the cloud can be skipped", async () => {
  const expired = fail(new OnyxError("expired", EXPIRED_MESSAGE))
  assert.deepEqual(await obtainBook({ cloud: expired, adb: async () => {} }), { ok: true, source: "adb", expired: true })
  const dir = mkdtempSync(join(tmpdir(), "fetch-"))
  let downloads = 0
  const fetchFile = createFetcher({
    cloud: () => async () => void downloads++,
    pull: async () => {
      throw noBoox
    },
  })
  assert.deepEqual(await fetchFile("/a.epub", join(dir, "a.epub"), 10, { cloud: false }), { ok: false, error: NOT_HERE, notHere: true })
  assert.equal(downloads, 0)
})

test("the books folder is created 0700 and an ADB copy is kept 0600", async () => {
  const data = join(mkdtempSync(join(tmpdir(), "fetch-")), "data")
  const file = join(data, "books", "book.epub")
  const fetchFile = createFetcher({ cloud: () => undefined, pull: async (_path, local) => writeFileSync(local, BOOK, { mode: 0o644 }) })
  assert.deepEqual(await fetchFile("/b.epub", file, BOOK.length), { ok: true, source: "adb" })
  assert.equal(statSync(data).mode & 0o777, 0o700)
  assert.equal(statSync(join(data, "books")).mode & 0o777, 0o700)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("a cached copy deleted or emptied since is no longer announced", () => {
  const dir = mkdtempSync(join(tmpdir(), "sources-"))
  try {
    const kept = join(dir, "kept.epub")
    const emptied = join(dir, "emptied.epub")
    writeFileSync(kept, "PK")
    writeFileSync(emptied, "")
    const manifest = {
      [kept]: { booxPath: "/Books/kept.epub", size: 2 },
      [emptied]: { booxPath: "/Books/emptied.epub", size: 2 },
      [join(dir, "deleted.epub")]: { booxPath: "/Books/deleted.epub", size: 2 },
    }
    assert.deepEqual(liveCopies(manifest), { [kept]: { booxPath: "/Books/kept.epub", size: 2 } })
    rmSync(kept)
    assert.deepEqual(liveCopies(manifest), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
