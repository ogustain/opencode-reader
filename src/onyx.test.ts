import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  connectOnyx, createOnyx, disconnectOnyx, EXPIRED_MESSAGE, onyxServer, readSettings, MAX_BOOK_FILE, MAX_JSON, MAX_LIBRARY_JSON, OnyxError, ossBookKey, ossBucketOf, ossRequest, ossSignature, ossStringToSign, readMarks, readToken, saveBackup, tokenFingerprint, updateMark, writePrivateFile,
  type CloudDoc,
} from "./onyx.ts"

const TOKEN = "header.payload.signature"
const NOW = Date.parse("2026-10-17T12:00:00Z")
const LATER = "2026-11-04T00:00:00Z"

type Call = { url: string; method: string; cookie?: string; auth?: string; body?: string }

/** A fake cloud: `sessions` are handed out in order; `valid` lists the session ids the gateway accepts. */
function fakeCloud(options: { sessions?: string[]; valid?: Set<string>; syncStatus?: number; docs?: unknown[] } = {}) {
  const calls: Call[] = []
  const sessions = [...(options.sessions ?? ["s1"])]
  const valid = options.valid ?? new Set(["s1"])
  const fake = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, method: init.method ?? "GET", cookie: headers.Cookie, auth: headers.Authorization, body: init.body as string | undefined })
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.endsWith("users/syncToken")) {
      if (options.syncStatus) return reply(options.syncStatus, { result_code: 401 })
      return reply(200, { result_code: 0, data: { cookie_name: "SyncGatewaySession", session_id: sessions.shift() ?? "sx", expires: LATER, channels: [] } })
    }
    const id = /SyncGatewaySession=([^;]+)/.exec(headers.Cookie ?? "")?.[1]
    if (!id || !valid.has(id)) return reply(401, { error: "Unauthorized" })
    if (url.endsWith("_session")) return reply(200, { ok: true, userCtx: { name: "u1", channels: {} } })
    if (url.includes("_changes?")) return reply(200, { results: (options.docs ?? []).map((doc) => ({ doc })), last_seq: 1 })
    if (init.method === "PUT") return reply(201, { ok: true, rev: "2-b" })
    return reply(200, { _id: decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)), _rev: "1-a", modeType: 4, uniqueId: "b1" })
  }) as typeof fetch
  return { fetch: fake, calls }
}

function files(token: string | null = `"${TOKEN}"\n`) {
  const dir = mkdtempSync(join(tmpdir(), "onyx-"))
  const tokenFile = join(dir, "token")
  if (token !== null) writeFileSync(tokenFile, token)
  return { tokenFile, sessionFile: join(dir, "session") }
}

test("tokens lose their quotes and surrounding blanks", () => {
  const { tokenFile } = files(` '${TOKEN}' \n`)
  assert.equal(readToken(tokenFile), TOKEN)
  assert.equal(readToken(join(tokenFile, "missing")), undefined)
})

test("the session is fetched once, cached in a 0600 file and reused by a new client", async () => {
  const paths = files()
  const cloud = fakeCloud({ docs: [{ _id: "u1#b1", modeType: 4 }, { _id: "u1#x", _deleted: true }] })
  const onyx = createOnyx({ ...paths, fetch: cloud.fetch, now: () => NOW })
  assert.equal(await onyx.userId(), "u1")
  assert.deepEqual((await onyx.library()).map((d) => d._id), ["u1#b1"])
  await onyx.getDoc("u1#b1")
  assert.equal(cloud.calls.filter((c) => c.url.endsWith("syncToken")).length, 1)
  assert.equal(cloud.calls.find((c) => c.url.endsWith("syncToken"))?.auth, `Bearer ${TOKEN}`)
  assert.ok(cloud.calls.find((c) => c.url.includes("_changes?"))?.url.includes("channels=u1-READER_LIBRARY&include_docs=true"))
  // The doc id's "#" is escaped in the URL.
  assert.ok(cloud.calls.at(-1)?.url.endsWith("/neocloud/u1%23b1"))
  assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(paths.sessionFile, "utf8")).user_id, "u1")

  const again = fakeCloud()
  const second = createOnyx({ ...paths, fetch: again.fetch, now: () => NOW })
  assert.equal(await second.userId(), "u1")
  assert.equal(again.calls.length, 0)
})

test("an expiring session is renewed, and a 401 renews it once", async () => {
  const paths = files()
  writeFileSync(paths.sessionFile, JSON.stringify({ cookie_name: "SyncGatewaySession", session_id: "old", expires: "2026-10-17T12:30:00Z" }))
  const cloud = fakeCloud({ sessions: ["s1"] })
  const onyx = createOnyx({ ...paths, fetch: cloud.fetch, now: () => NOW })
  await onyx.userId()
  assert.equal(cloud.calls[0].url.endsWith("syncToken"), true) // Expires within the margin: renewed first.

  // The gateway drops the session early: one renewal, then the request succeeds.
  const valid = new Set(["s2"])
  const revoked = fakeCloud({ sessions: ["s2"], valid })
  const bound = { server: "https://eurcb.boox.com/neocloud/", token_sha: tokenFingerprint(TOKEN) }
  writeFileSync(paths.sessionFile, JSON.stringify({ cookie_name: "SyncGatewaySession", session_id: "s1", expires: LATER, user_id: "u1", ...bound }))
  const client = createOnyx({ ...paths, fetch: revoked.fetch, now: () => NOW })
  const doc = await client.getDoc("u1#b1")
  assert.equal(doc._id, "u1#b1")
  assert.deepEqual(revoked.calls.map((c) => c.cookie ?? "token"), ["SyncGatewaySession=s1", "token", "SyncGatewaySession=s2"])

  // Still refused after the renewal: reported as expired, not retried forever.
  const dead = fakeCloud({ sessions: ["s3"], valid: new Set() })
  const stuck = createOnyx({ ...paths, fetch: dead.fetch, now: () => NOW })
  await assert.rejects(stuck.getDoc("u1#b1"), (e: OnyxError) => e.state === "expired")
  assert.equal(dead.calls.length, 3)
})

test("errors say what to do and never carry the token or the session id", async () => {
  const expired = createOnyx({ ...files(), fetch: fakeCloud({ syncStatus: 401 }).fetch, now: () => NOW })
  await assert.rejects(expired.userId(), (e: OnyxError) => e.state === "expired" && e.message === EXPIRED_MESSAGE)

  const off = createOnyx({ ...files(null), fetch: fakeCloud().fetch, now: () => NOW })
  assert.equal(off.configured(), false)
  await assert.rejects(off.library(), (e: OnyxError) => e.state === "off")

  const offline = createOnyx({
    ...files(),
    fetch: (async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`)
    }) as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(offline.library(), (e: OnyxError) => e.state === "offline" && !e.message.includes(TOKEN))

  const failing = createOnyx({ ...files(), fetch: (async () => new Response(`bad ${TOKEN} s1`, { status: 500 })) as typeof fetch, now: () => NOW })
  await assert.rejects(failing.userId(), (e: OnyxError) => e.state === "error" && !e.message.includes(TOKEN) && !e.message.includes("s1"))
})

test("PUT only accepts book docs with a revision", async () => {
  const cloud = fakeCloud()
  const onyx = createOnyx({ ...files(), fetch: cloud.fetch, now: () => NOW })
  assert.equal(await onyx.putDoc({ _id: "u1#b1", _rev: "1-a", modeType: 4, uniqueId: "b1" }), "2-b")
  const put = cloud.calls.find((c) => c.method === "PUT")!
  assert.ok(put.url.endsWith("/neocloud/u1%23b1"))
  assert.equal(JSON.parse(put.body!)._rev, "1-a")
  for (const doc of [
    { _id: "u1#a1", _rev: "1-a", modeType: 1, uniqueId: "a1" },
    { _id: "u1#b1", modeType: 4, uniqueId: "b1" },
    { _id: "u2#b1", _rev: "1-a", modeType: 4, uniqueId: "b1" },
  ])
    await assert.rejects(onyx.putDoc(doc), /only book documents/)
  assert.equal(cloud.calls.filter((c) => c.method !== "GET" && c.method !== "PUT").length, 0)
  assert.equal(cloud.calls.filter((c) => c.method === "PUT").length, 1)
})

test("backups keep the last revisions before each push, 0600", () => {
  const file = join(mkdtempSync(join(tmpdir(), "onyx-")), "backups.json")
  for (let i = 1; i <= 23; i++) saveBackup(file, { _id: "u1#b1", _rev: `${i}-r`, modeType: 4 }, i)
  const ring = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(ring.length, 20)
  assert.deepEqual([ring[0].rev, ring.at(-1).rev, ring.at(-1).doc._rev], ["4-r", "23-r", "23-r"])
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("the cached session belongs to one token and one server", async () => {
  // Each token buys a session of its own account.
  const calls: string[] = []
  const fake = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.endsWith("users/syncToken")) {
      const account = headers.Authorization === "Bearer token-a" ? "a" : "b"
      calls.push(`${new URL(url).host} token-${account}`)
      return reply({ result_code: 0, data: { cookie_name: "SyncGatewaySession", session_id: `session-${account}`, expires: LATER } })
    }
    calls.push(`${new URL(url).host} ${headers.Cookie}`)
    const account = headers.Cookie?.endsWith("session-a") ? "a" : "b"
    if (url.endsWith("_session")) return reply({ userCtx: { name: `user-${account}` } })
    return reply({ ok: true, rev: "2-x" })
  }) as typeof fetch
  const paths = files("token-a")
  assert.equal(await createOnyx({ ...paths, fetch: fake, now: () => NOW }).userId(), "user-a")
  const saved = readFileSync(paths.sessionFile, "utf8")
  assert.equal(JSON.parse(saved).token_sha, tokenFingerprint("token-a"))
  assert.ok(!saved.includes("token-a"))

  // A new token, same client and a new client: a new session, and the PUT carries it.
  const client = createOnyx({ ...paths, fetch: fake, now: () => NOW })
  assert.equal(await client.userId(), "user-a")
  writeFileSync(paths.tokenFile, "token-b")
  assert.equal(await client.userId(), "user-b")
  assert.equal(await createOnyx({ ...paths, fetch: fake, now: () => NOW }).userId(), "user-b")
  calls.length = 0
  await client.putDoc({ _id: "user-b#b1", _rev: "1-a", modeType: 4, uniqueId: "b1" })
  assert.deepEqual(calls, ["eurcb.boox.com SyncGatewaySession=session-b"])

  // Another server: a new session there.
  calls.length = 0
  await createOnyx({ ...paths, server: "us", fetch: fake, now: () => NOW }).userId()
  assert.deepEqual(calls, ["push.boox.com token-b", "cb.boox.com SyncGatewaySession=session-b"])

  // No token: the session is forgotten, in memory and on disk.
  rmSync(paths.tokenFile)
  await assert.rejects(client.userId(), (e: OnyxError) => e.state === "off")
  assert.equal(existsSync(paths.sessionFile), false)
})

test("existing token, session and backup files readable by others are made 0600", async () => {
  const mode = (file: string) => statSync(file).mode & 0o777
  const paths = files()
  chmodSync(paths.tokenFile, 0o644)
  // A valid cached session left 0644: reused without a write, and still fixed.
  const bound = { server: "https://eurcb.boox.com/neocloud/", token_sha: tokenFingerprint(TOKEN) }
  writeFileSync(paths.sessionFile, JSON.stringify({ cookie_name: "SyncGatewaySession", session_id: "s1", expires: LATER, user_id: "u1", ...bound }), { mode: 0o644 })
  chmodSync(paths.sessionFile, 0o644)
  const cloud = fakeCloud()
  assert.equal(await createOnyx({ ...paths, fetch: cloud.fetch, now: () => NOW }).userId(), "u1")
  assert.equal(cloud.calls.length, 0)
  assert.deepEqual([mode(paths.tokenFile), mode(paths.sessionFile)], [0o600, 0o600])

  // Rewritten sessions too (writeFileSync's mode only applies to new files).
  chmodSync(paths.sessionFile, 0o644)
  writeFileSync(paths.sessionFile, "{}")
  await createOnyx({ ...paths, fetch: fakeCloud().fetch, now: () => NOW }).userId()
  assert.equal(mode(paths.sessionFile), 0o600)

  const backups = join(mkdtempSync(join(tmpdir(), "onyx-")), "backups.json")
  writeFileSync(backups, "[]", { mode: 0o644 })
  chmodSync(backups, 0o644)
  saveBackup(backups, { _id: "u1#b1", _rev: "1-r", modeType: 4 }, 1)
  assert.equal(mode(backups), 0o600)
})

// ---------------------------------------------------------------------------
// Book files in the cloud storage (OSS)

const SECRET = "test-secret"
const STS_TOKEN = "CAIS-test-token"
const KEY_ID = "STS.test-key-id"
const EPUB = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(300, 7)])

test("OSS V1 signature matches an independent computation", () => {
  const key = ossBookKey("uid1", "book1", "epub")!
  assert.equal(key, "uid1/reader/book1/book/book1.epub")
  const date = "Sun, 18 Oct 2026 12:00:00 GMT"
  const signed = ossStringToSign("GET", date, STS_TOKEN, "test-bucket", key)
  assert.equal(signed, `GET\n\n\n${date}\nx-oss-security-token:${STS_TOKEN}\n/test-bucket/${key}`)
  // python3: base64(hmac.new(b"test-secret", s.encode(), hashlib.sha1).digest())
  assert.equal(ossSignature(SECRET, signed), "yPboBuKoiMtcMbDfVKnIcPgbQ48=")
  assert.equal(ossSignature(SECRET, ossStringToSign("HEAD", date, STS_TOKEN, "test-bucket", key)), "jVhJjoL3JzJ1cDqe2ukJgoXvgjI=")
  const credentials = { AccessKeyId: KEY_ID, AccessKeySecret: SECRET, SecurityToken: STS_TOKEN, Expiration: LATER }
  const request = ossRequest("GET", credentials, { bucket: "test-bucket", endpoint: "oss-us-west-1.aliyuncs.com" }, key, new Date(date))
  assert.deepEqual(request, {
    url: "https://test-bucket.oss-us-west-1.aliyuncs.com/uid1/reader/book1/book/book1.epub",
    headers: { Date: date, "x-oss-security-token": STS_TOKEN, Authorization: `OSS ${KEY_ID}:yPboBuKoiMtcMbDfVKnIcPgbQ48=` },
  })
})

test("book keys and buckets stay inside their path and on Aliyun", () => {
  assert.equal(ossBookKey("uid1", "../other", "epub"), undefined)
  assert.equal(ossBookKey("uid/1", "b", "epub"), undefined)
  assert.equal(ossBookKey("uid1", "b", "ep/ub"), undefined)
  const buckets = { "onyx-cloud": { region: "oss-us-west-1", bucket: "onyx-cloud-us", aliEndpoint: "oss-us-west-1.aliyuncs.com" }, "onyx-cloud-eu": { bucket: "onyx-cloud-eu", aliEndpoint: "oss-eu-central-1.aliyuncs.com" } }
  assert.deepEqual(ossBucketOf(buckets), { bucket: "onyx-cloud-us", endpoint: "oss-us-west-1.aliyuncs.com" })
  assert.equal(ossBucketOf({ "onyx-cloud": { bucket: "b", aliEndpoint: "evil.example.com" } }), undefined)
  assert.equal(ossBucketOf({ "onyx-cloud": { bucket: "onyx-cloud-us", aliEndpoint: "aliyuncs.com.evil.example" } }), undefined)
  assert.equal(ossBucketOf({}), undefined)
})

/** Cloud with a session for u1, STS credentials expiring at `expiration`, and an OSS bucket holding `objects`. */
function fakeStorage(options: { objects?: Record<string, Buffer>; expiration?: string; status?: number; length?: number } = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
  let issued = 0
  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, method: init.method ?? "GET", headers })
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.endsWith("users/syncToken")) return reply({ result_code: 0, data: { cookie_name: "SyncGatewaySession", session_id: "s1", expires: LATER } })
    if (url.endsWith("_session")) return reply({ userCtx: { name: "u1" } })
    if (url.endsWith("config/stss")) {
      issued++
      return reply({ result_code: 0, data: { AccessKeyId: `${KEY_ID}-${issued}`, AccessKeySecret: SECRET, SecurityToken: STS_TOKEN, Expiration: options.expiration ?? "2026-10-17T12:15:00Z" } })
    }
    if (url.endsWith("config/buckets"))
      return reply({ result_code: 0, data: { "onyx-cloud": { region: "oss-us-west-1", bucket: "onyx-cloud-us", aliEndpoint: "oss-us-west-1.aliyuncs.com" } } })
    const host = "https://onyx-cloud-us.oss-us-west-1.aliyuncs.com/"
    if (url.startsWith(host)) {
      if (options.status) return new Response("<Error/>", { status: options.status })
      const object = options.objects?.[decodeURIComponent(url.slice(host.length))]
      const length = options.length ? { headers: { "content-length": String(options.length) } } : {}
      return object ? new Response(new Uint8Array(object), { status: 200, ...length }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    }
    return new Response("{}", { status: 404 })
  }
  return { fetch: fake as typeof fetch, calls, issued: () => issued }
}

const KEY = "u1/reader/b1/book/b1.epub"
const bookDoc = (extra: Record<string, unknown> = {}) => ({ _id: "u1#b1", modeType: 4, uniqueId: "b1", type: "epub", fileOriginSize: EPUB.length, ...extra })
const cacheDir = () => mkdtempSync(join(tmpdir(), "onyx-books-"))

test("a book file downloads with signed requests, and the credentials are reused until they expire", async () => {
  let clock = NOW
  const storage = fakeStorage({ objects: { [KEY]: EPUB } })
  const paths = files()
  const onyx = createOnyx({ ...paths, fetch: storage.fetch, now: () => clock })
  const dir = cacheDir()
  assert.equal(await onyx.downloadBook(bookDoc(), join(dir, "book.epub"), EPUB.length), EPUB.length)
  assert.ok(readFileSync(join(dir, "book.epub")).equals(EPUB))
  assert.deepEqual(readdirSync(dir), ["book.epub"])
  assert.equal(statSync(join(dir, "book.epub")).mode & 0o777, 0o600)
  await onyx.downloadBook(bookDoc(), join(dir, "new", "book.epub"))
  assert.equal(statSync(join(dir, "new")).mode & 0o777, 0o700)
  const get = storage.calls.find((c) => c.url.includes("aliyuncs.com"))!
  assert.equal(get.method, "GET")
  assert.equal(get.headers["x-oss-security-token"], STS_TOKEN)
  assert.match(get.headers.Authorization, /^OSS STS\.test-key-id-1:[A-Za-z0-9+/]+=*$/)
  assert.equal(get.headers.Authorization, `OSS ${KEY_ID}-1:${ossSignature(SECRET, ossStringToSign("GET", get.headers.Date, STS_TOKEN, "onyx-cloud-us", KEY))}`)

  // Within the 15 minutes (less one): same credentials, bucket list not asked again.
  clock = NOW + 13 * 60_000
  await onyx.downloadBook(bookDoc(), join(dir, "again.epub"))
  assert.equal(storage.issued(), 1)
  // Past expiry minus a minute: new credentials.
  clock = NOW + 14 * 60_000 + 1
  await onyx.downloadBook(bookDoc(), join(dir, "third.epub"))
  assert.equal(storage.issued(), 2)
  // A new token: new credentials too.
  writeFileSync(paths.tokenFile, "another-token")
  await onyx.downloadBook(bookDoc(), join(dir, "fourth.epub"))
  assert.equal(storage.issued(), 3)
  assert.equal(storage.calls.filter((c) => c.url.endsWith("config/buckets")).length, 1)
  assert.ok(storage.calls.every((c) => c.method === "GET"))
})

test("wrong size, non-ZIP, missing and refused files leave nothing behind, and errors carry no credentials", async () => {
  const errors: string[] = []
  const attempt = async (storage: ReturnType<typeof fakeStorage>, doc: Record<string, unknown>, size: number, state: string) => {
    const dir = cacheDir()
    const onyx = createOnyx({ ...files(), fetch: storage.fetch, now: () => NOW })
    await assert.rejects(onyx.downloadBook(doc as CloudDoc, join(dir, "book.epub"), size), (e: OnyxError) => {
      errors.push(e.message)
      return e.state === state
    })
    assert.deepEqual(readdirSync(dir), [], state)
  }
  const short = EPUB.subarray(0, 200)
  await attempt(fakeStorage({ objects: { [KEY]: short } }), bookDoc(), 0, "error") // fileOriginSize says 304.
  await attempt(fakeStorage({ objects: { [KEY]: EPUB } }), bookDoc({ fileOriginSize: undefined }), 999, "error") // Boox size differs.
  // No size known: the announced length is still capped.
  await attempt(fakeStorage({ objects: { [KEY]: EPUB }, length: MAX_BOOK_FILE + 1 }), bookDoc({ fileOriginSize: undefined }), 0, "error")
  const html = Buffer.alloc(EPUB.length, 60)
  await attempt(fakeStorage({ objects: { [KEY]: html } }), bookDoc(), 0, "error")
  await attempt(fakeStorage(), bookDoc(), 0, "missing")
  await attempt(fakeStorage({ status: 403 }), bookDoc(), 0, "missing")
  await attempt(fakeStorage({ objects: { [KEY]: EPUB } }), bookDoc({ type: "pdf" }), 0, "error")
  const offline = createOnyx({
    ...files(),
    fetch: (async (input: string | URL | Request) => {
      if (String(input).includes("aliyuncs.com")) throw new TypeError(`connect failed ${SECRET} ${STS_TOKEN}`)
      return fakeStorage().fetch(input)
    }) as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(offline.downloadBook(bookDoc() as CloudDoc, join(cacheDir(), "book.epub")), (e: OnyxError) => (errors.push(e.message), e.state === "offline"))
  for (const message of errors) for (const secret of [SECRET, STS_TOKEN, KEY_ID, TOKEN, "s1"]) assert.ok(!message.includes(secret), message)
})

test("a download never replaces a valid copy published meanwhile", async () => {
  const dir = cacheDir()
  const dest = join(dir, "book.epub")
  const published = Buffer.concat([Buffer.from("PK"), Buffer.alloc(EPUB.length - 2, 1)])
  writeFileSync(dest, published)
  const onyx = createOnyx({ ...files(), fetch: fakeStorage({ objects: { [KEY]: EPUB } }).fetch, now: () => NOW })
  assert.equal(await onyx.downloadBook(bookDoc(), dest, EPUB.length), EPUB.length)
  assert.ok(readFileSync(dest).equals(published))
  assert.deepEqual(readdirSync(dir), ["book.epub"])
})

test("every request refuses redirects and has a timeout", async () => {
  const paths = files()
  const cloud = fakeCloud({ docs: [{ _id: "u1#b1", modeType: 4 }] })
  const inits: RequestInit[] = []
  const spy = (async (input: string | URL | Request, init: RequestInit = {}) => {
    inits.push(init)
    return cloud.fetch(input, init)
  }) as typeof fetch
  const onyx = createOnyx({ ...paths, fetch: spy, now: () => NOW })
  await onyx.library()
  await onyx.putDoc(await onyx.getDoc("u1#b1"))
  const storage = fakeStorage({ objects: { [KEY]: EPUB } })
  const spyStorage = (async (input: string | URL | Request, init: RequestInit = {}) => (inits.push(init), storage.fetch(input, init))) as typeof fetch
  await createOnyx({ ...files(), fetch: spyStorage, now: () => NOW }).downloadBook(bookDoc(), join(cacheDir(), "book.epub"))
  assert.ok(storage.calls.some((c) => c.url.includes("aliyuncs.com")) && storage.calls.some((c) => c.url.endsWith("config/stss")))
  assert.ok(inits.length >= 9)
  for (const init of inits) {
    assert.equal(init.redirect, "error")
    assert.ok(init.signal instanceof AbortSignal)
  }
})

test("JSON replies are read up to a byte cap, and stop there", async () => {
  const MiB = 1024 * 1024
  /** A reply to `match` that streams `size` bytes (endless when undefined), declared or not. */
  const huge = (match: string, size: number | undefined, declare = false) => {
    let pulled = 0
    const cloud = fakeCloud({ docs: [{ _id: "u1#b1", modeType: 4 }] })
    const fake = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (!String(input).includes(match)) return cloud.fetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (size !== undefined && pulled >= size) return controller.close()
          pulled += MiB
          controller.enqueue(new Uint8Array(MiB).fill(32))
        },
      })
      return new Response(body, { status: 200, headers: declare && size !== undefined ? { "content-length": String(size) } : {} })
    }) as typeof fetch
    return { onyx: createOnyx({ ...files(), fetch: fake, now: () => NOW }), pulled: () => pulled }
  }
  const tooLarge = (e: OnyxError) => e.state === "error" && /too large/.test(e.message)

  const endless = huge("u1%23b1", undefined)
  await assert.rejects(endless.onyx.getDoc("u1#b1"), tooLarge)
  assert.ok(endless.pulled() <= MAX_JSON + 2 * MiB, `${endless.pulled()}`)
  const declared = huge("u1%23b1", MAX_JSON + 1, true)
  await assert.rejects(declared.onyx.getDoc("u1#b1"), tooLarge)
  assert.ok(declared.pulled() <= 2 * MiB) // Refused on the declared length.

  // The library feed may be larger, up to its own cap.
  const library = huge("_changes?", MAX_JSON + MiB)
  await assert.rejects(library.onyx.library(), /invalid response/) // Read in full: blanks only.
  const endlessLibrary = huge("_changes?", undefined)
  await assert.rejects(endlessLibrary.onyx.library(), tooLarge)
  assert.ok(endlessLibrary.pulled() <= MAX_LIBRARY_JSON + 2 * MiB)
})

test("private files are replaced whole, 0600, with no temp file left", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "onyx-")), "data")
  const file = join(dir, "session")
  writePrivateFile(file, "one")
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  writeFileSync(file, "old", { mode: 0o644 })
  chmodSync(file, 0o644)
  writePrivateFile(file, "two")
  assert.equal(readFileSync(file, "utf8"), "two")
  assert.equal(statSync(file).mode & 0o777, 0o600) // A new file, not the old 0644 one rewritten.
  assert.deepEqual(readdirSync(dir), ["session"])
  // Large content is written whole (multi-byte characters included).
  const big = "é".repeat(3_000_000)
  writePrivateFile(file, big)
  assert.equal(readFileSync(file, "utf8"), big)
  // A failed write leaves the old content and no temp file.
  assert.throws(() => writePrivateFile(join(file, "below"), "x"))
  assert.deepEqual(readdirSync(dir), ["session"])
})

test("a corrupt backup ring is moved aside, not dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-"))
  const file = join(dir, "onyx-backups.json")
  for (const junk of ['[{"at":1', '{"not":"a ring"}']) {
    rmSync(dir, { recursive: true, force: true })
    writePrivateFile(file, junk)
    saveBackup(file, { _id: "u1#b1", _rev: "2-r", modeType: 4 }, 42)
    assert.deepEqual(readdirSync(dir).sort(), ["onyx-backups.json", "onyx-backups.json.corrupt-42"])
    assert.equal(readFileSync(join(dir, "onyx-backups.json.corrupt-42"), "utf8"), junk)
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((b: { rev: string }) => b.rev), ["2-r"])
  }
})

test("token, session and backup files that are symbolic links are never followed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-"))
  const target = join(dir, "elsewhere")
  writeFileSync(target, TOKEN, { mode: 0o644 })
  chmodSync(target, 0o644)
  const mode = () => statSync(target).mode & 0o777

  // Token: refused with a clear error, the target left as it was.
  const tokenFile = join(dir, "token")
  symlinkSync(target, tokenFile)
  assert.throws(() => readToken(tokenFile), /token is a symbolic link/)
  const cloud = fakeCloud()
  const onyx = createOnyx({ tokenFile, sessionFile: join(dir, "session"), fetch: cloud.fetch, now: () => NOW })
  assert.equal(onyx.configured(), true)
  await assert.rejects(onyx.library(), (e: OnyxError) => e.state === "error" && /symbolic link/.test(e.message) && !e.message.includes(TOKEN))
  assert.equal(cloud.calls.length, 0)
  assert.equal(mode(), 0o644)

  // Session: the link is not read, and a new session replaces the link, not its target.
  const paths = files()
  rmSync(paths.sessionFile, { force: true })
  symlinkSync(target, paths.sessionFile)
  await createOnyx({ ...paths, fetch: fakeCloud().fetch, now: () => NOW }).userId()
  assert.ok(!lstatSync(paths.sessionFile).isSymbolicLink())
  assert.equal(readFileSync(target, "utf8"), TOKEN)
  assert.equal(mode(), 0o644)

  // Backups: refused, the target untouched.
  const backups = join(dir, "backups.json")
  symlinkSync(target, backups)
  assert.throws(() => saveBackup(backups, { _id: "u1#b1", _rev: "1-r", modeType: 4 }, 1), /symbolic link/)
  assert.equal(readFileSync(target, "utf8"), TOKEN)
  assert.equal(mode(), 0o644)
})

test("the sync record (base and attempt) survives a restart, and an unreadable one counts as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-reader-marks-"))
  try {
    const file = join(dir, "onyx-sync.json")
    assert.deepEqual(readMarks(file), {})
    updateMark(file, "u1#b1", () => ({ base: { rev: "3-a", print: "[1]", localAt: 100 }, attempt: { print: "[2]", localAt: 120 } }))
    updateMark(file, "u1#b2", () => ({}))
    assert.deepEqual(readMarks(file)["u1#b1"], { base: { rev: "3-a", print: "[1]", localAt: 100 }, attempt: { print: "[2]", localAt: 120 } })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    writeFileSync(file, "{not json")
    assert.deepEqual(readMarks(file), {})
    writeFileSync(file, "[1]")
    assert.deepEqual(readMarks(file), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A connect setup: a client whose region follows the settings file, as the plugin's does. */
function connectSetup(token: string | null = null) {
  const paths = files(token)
  const settingsFile = join(paths.tokenFile, "..", "settings.json")
  // The check buys a session it does not keep: the next request buys another.
  const cloud = fakeCloud({ sessions: ["checked", "s1"], valid: new Set(["s1"]) })
  const onyx = createOnyx({ ...paths, server: () => onyxServer(undefined, settingsFile), fetch: cloud.fetch, now: () => NOW })
  return { ...paths, settingsFile, cloud, onyx }
}

test("connecting checks the pasted token first, then saves it 0600 with the region, and starts a new session", async () => {
  const setup = connectSetup("old-token")
  writeFileSync(setup.sessionFile, JSON.stringify({ cookie_name: "SyncGatewaySession", session_id: "old", expires: LATER, server: "https://eurcb.boox.com/neocloud/", token_sha: tokenFingerprint("old-token") }))
  const result = await connectOnyx(setup.onyx, { token: ` "${TOKEN}"\n`, server: "us" }, setup)
  assert.deepEqual(result, { ok: true })
  // Checked with the pasted token on the chosen region, before anything was saved.
  assert.deepEqual(setup.cloud.calls.map((c) => [c.url, c.auth]), [["https://push.boox.com/api/1/users/syncToken", `Bearer ${TOKEN}`]])
  assert.equal(readToken(setup.tokenFile), TOKEN)
  assert.equal(statSync(setup.tokenFile).mode & 0o777, 0o600)
  assert.deepEqual(readSettings(setup.settingsFile), { server: "us" })
  assert.equal(statSync(setup.settingsFile).mode & 0o777, 0o600)
  assert.equal(existsSync(setup.sessionFile), false)
  // The client uses the new token and region at once, without a restart.
  setup.cloud.calls.length = 0
  await setup.onyx.library()
  assert.deepEqual(setup.cloud.calls.map((c) => new URL(c.url).host), ["push.boox.com", "cb.boox.com", "cb.boox.com"])
  assert.equal(setup.cloud.calls[0].auth, `Bearer ${TOKEN}`)
})

test("a refused token is never saved and the existing one is kept; errors never carry it", async () => {
  const paths = files("old-token")
  const settingsFile = join(paths.tokenFile, "..", "settings.json")
  const refused = fakeCloud({ syncStatus: 401 })
  const onyx = createOnyx({ ...paths, server: () => onyxServer(undefined, settingsFile), fetch: refused.fetch, now: () => NOW })
  const result = await connectOnyx(onyx, { token: TOKEN, server: "eur" }, { ...paths, settingsFile })
  assert.deepEqual(result, { ok: false, error: "the Onyx cloud refused this token" })
  assert.equal(readFileSync(paths.tokenFile, "utf8"), "old-token")
  assert.equal(existsSync(settingsFile), false)

  const offline = createOnyx({ ...paths, fetch: (async () => { throw new TypeError(TOKEN) }) as typeof fetch, now: () => NOW })
  const down = await connectOnyx(offline, { token: TOKEN, server: "eur" }, { ...paths, settingsFile })
  assert.ok(!down.ok && down.error.startsWith("offline") && !down.error.includes(TOKEN))
  assert.equal(readFileSync(paths.tokenFile, "utf8"), "old-token")

  for (const input of [{ token: "  ", server: "eur" }, { token: TOKEN, server: "asia" }]) {
    const bad = await connectOnyx(onyx, input, { ...paths, settingsFile })
    assert.ok(!bad.ok && !bad.error.includes(TOKEN))
  }
  assert.equal(refused.calls.length, 1)
})

test("connecting refuses a token file that is a symbolic link, before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-"))
  const target = join(dir, "elsewhere")
  writeFileSync(target, "old-token")
  const tokenFile = join(dir, "token")
  symlinkSync(target, tokenFile)
  const cloud = fakeCloud()
  const onyx = createOnyx({ tokenFile, sessionFile: join(dir, "session"), fetch: cloud.fetch, now: () => NOW })
  const result = await connectOnyx(onyx, { token: TOKEN, server: "eur" }, { tokenFile, settingsFile: join(dir, "settings.json") })
  assert.ok(!result.ok && /symbolic link/.test(result.error))
  assert.equal(cloud.calls.length, 0)
  assert.ok(lstatSync(tokenFile).isSymbolicLink())
  assert.equal(readFileSync(target, "utf8"), "old-token")
})

test("disconnecting deletes the token and the session, and keeps backups, sync records and settings", async () => {
  const setup = connectSetup()
  assert.deepEqual(await connectOnyx(setup.onyx, { token: TOKEN, server: "eur" }, setup), { ok: true })
  await setup.onyx.library()
  assert.ok(existsSync(setup.sessionFile))
  const dir = join(setup.tokenFile, "..")
  saveBackup(join(dir, "onyx-backups.json"), { _id: "u1#b1", _rev: "1-r", modeType: 4 }, 1)
  updateMark(join(dir, "onyx-sync.json"), "u1#b1", () => ({}))
  writePrivateFile(join(dir, "books", "a.epub"), "PK")
  assert.deepEqual(disconnectOnyx(setup.onyx, setup), { ok: true })
  assert.equal(existsSync(setup.tokenFile), false)
  assert.equal(existsSync(setup.sessionFile), false)
  assert.equal(setup.onyx.configured(), false)
  await assert.rejects(setup.onyx.library(), (e: OnyxError) => e.state === "off")
  for (const kept of ["onyx-backups.json", "onyx-sync.json", "settings.json", join("books", "a.epub")]) assert.ok(existsSync(join(dir, kept)), kept)
})

test("the server option wins over the region saved in settings.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-"))
  const settingsFile = join(dir, "settings.json")
  assert.deepEqual(readSettings(settingsFile), {})
  assert.equal(onyxServer(undefined, settingsFile), undefined)
  writePrivateFile(settingsFile, JSON.stringify({ server: "us" }))
  assert.equal(onyxServer(undefined, settingsFile), "us")
  assert.equal(onyxServer("eur", settingsFile), "eur")
  writeFileSync(settingsFile, "{ not json")
  assert.equal(onyxServer(undefined, settingsFile), undefined)

  writePrivateFile(settingsFile, JSON.stringify({ server: "us" }))
  const hosts = async (option: unknown) => {
    const cloud = fakeCloud()
    await createOnyx({ ...files(), server: () => onyxServer(option, settingsFile), fetch: cloud.fetch, now: () => NOW }).userId()
    return new URL(cloud.calls[0].url).host
  }
  assert.equal(await hosts(undefined), "push.boox.com")
  assert.equal(await hosts("eur"), "eur.boox.com")
})

test("a push under way when the BOOX is disconnected sends no PUT and keeps no session", async () => {
  // Disconnected while the push buys its session (its first await).
  const paths = files()
  const cloud = fakeCloud()
  let onyx: ReturnType<typeof createOnyx>
  const signals: AbortSignal[] = []
  const racing = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.signal) signals.push(init.signal)
    if (String(input).endsWith("users/syncToken")) disconnectOnyx(onyx, paths)
    return cloud.fetch(input, init)
  }) as typeof fetch
  onyx = createOnyx({ ...paths, fetch: racing, now: () => NOW })
  const doc = { _id: "u1#b1", _rev: "1-a", modeType: 4, uniqueId: "b1" }
  await assert.rejects(onyx.putDoc(doc), (e: OnyxError) => e.state === "off" && e.message === "Onyx cloud disconnected")
  assert.deepEqual(cloud.calls.map((c) => c.method), ["GET"])
  assert.equal(existsSync(paths.sessionFile), false)
  assert.ok(signals[0].aborted, "the request in flight is aborted")

  // A saved session: disconnected right after the push starts, before its PUT.
  const saved = files()
  const bound = { server: "https://eurcb.boox.com/neocloud/", token_sha: tokenFingerprint(TOKEN) }
  writeFileSync(saved.sessionFile, JSON.stringify({ cookie_name: "SyncGatewaySession", session_id: "s1", expires: LATER, user_id: "u1", ...bound }))
  const quiet = fakeCloud()
  const client = createOnyx({ ...saved, fetch: quiet.fetch, now: () => NOW })
  const push = client.putDoc(doc)
  disconnectOnyx(client, saved)
  await assert.rejects(push, (e: OnyxError) => e.state === "off")
  assert.equal(quiet.calls.length, 0)
  assert.equal(existsSync(saved.sessionFile), false)

  // A new token after the disconnect: the client works again.
  writeFileSync(saved.tokenFile, TOKEN)
  assert.equal(await client.putDoc(doc), "2-b")
})

test("a library read or a download under way when the BOOX is disconnected keeps nothing", async () => {
  const paths = files()
  const cloud = fakeCloud({ docs: [{ _id: "u1#b1", modeType: 4 }] })
  let onyx: ReturnType<typeof createOnyx>
  const racing = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input).includes("_changes?")) onyx.reset()
    return cloud.fetch(input, init)
  }) as typeof fetch
  onyx = createOnyx({ ...paths, fetch: racing, now: () => NOW })
  await assert.rejects(onyx.library(), (e: OnyxError) => e.state === "off")
  assert.equal(existsSync(paths.sessionFile), false)

  const storage = fakeStorage({ objects: { [KEY]: EPUB } })
  const dir = cacheDir()
  let client: ReturnType<typeof createOnyx>
  const slow = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input).includes("aliyuncs.com")) client.reset()
    return storage.fetch(input, init)
  }) as typeof fetch
  client = createOnyx({ ...files(), fetch: slow, now: () => NOW })
  await assert.rejects(client.downloadBook(bookDoc(), join(dir, "book.epub")), (e: OnyxError) => e.state === "off")
  assert.deepEqual(readdirSync(dir), [])
})
