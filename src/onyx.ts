/**
 * Onyx cloud client (unofficial API): the Couchbase Sync Gateway that
 * NeoReader's library sync talks to.
 *
 * The user's JWT (from the send2boox web app) buys a Sync Gateway session
 * cookie (`users/syncToken`, valid ~18 days), cached in a 0600 file and
 * refreshed once on a 401. The cached session is bound to the server and to a
 * fingerprint of the token (a SHA-256 prefix, never the token): a new token or
 * another server starts a new session. The token, the session id and the
 * Cookie header never appear in errors or logs.
 *
 * Book files uploaded from the Boox ("Upload source file") are in Aliyun OSS:
 * short-lived STS credentials (`config/stss`, ~15 min) sign a GET (OSS V1) of
 * `<uid>/reader/<uniqueId>/book/<uniqueId>.epub` in the `onyx-cloud` bucket.
 * The credentials stay in memory and never appear in errors or logs.
 *
 * Only GET and PUT exist here, and PUT only accepts book docs (modeType 4).
 */
import { createHash, createHmac, randomBytes } from "node:crypto"
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { defaultDataDir } from "./paths.ts"
import { EXPIRED_MESSAGE } from "./sync.ts"

export type OnyxServer = "eur" | "us"
export const ENDPOINTS: Record<OnyxServer, { api: string; gateway: string }> = {
  eur: { api: "https://eur.boox.com/api/1/", gateway: "https://eurcb.boox.com/neocloud/" },
  us: { api: "https://push.boox.com/api/1/", gateway: "https://cb.boox.com/neocloud/" },
}

export const defaultTokenFile = (dataDir = defaultDataDir()) => join(dataDir, "onyx-token")
export const defaultSessionFile = (dataDir = defaultDataDir()) => join(dataDir, "onyx-sync-session")

/**
 * off: no token; expired: the token was refused; offline: no network;
 * conflict: PUT lost a race; missing: no book file in the cloud storage.
 */
export type OnyxState = "ok" | "off" | "expired" | "offline" | "conflict" | "missing" | "error"

export class OnyxError extends Error {
  readonly state: OnyxState
  constructor(state: OnyxState, message: string) {
    super(message)
    this.state = state
  }
}

export { EXPIRED_MESSAGE }

export type Session = {
  cookie_name: string
  session_id: string
  expires: string
  channels?: unknown
  user_id?: string
  /** Gateway URL and token fingerprint the session was bought with. */
  server?: string
  token_sha?: string
}
/** A Sync Gateway document. */
export type CloudDoc = Record<string, unknown> & { _id: string; _rev?: string; modeType?: number }

type Fetch = typeof fetch

export type OnyxOptions = {
  server?: unknown
  tokenFile?: string
  sessionFile?: string
  fetch?: Fetch
  now?: () => number
  timeoutMs?: number
  /** Whole book download, body included. */
  downloadTimeoutMs?: number
}

export type Onyx = {
  /** True when a token file is present (the cloud may still be unreachable). */
  configured(): boolean
  userId(): Promise<string>
  /** Live docs of the `<uid>-READER_LIBRARY` channel (deleted ones dropped). */
  library(): Promise<CloudDoc[]>
  getDoc(id: string): Promise<CloudDoc>
  /** PUT of a book doc carrying its `_rev`; returns the new revision. */
  putDoc(doc: CloudDoc): Promise<string>
  /**
   * Downloads the uploaded EPUB of a book doc to `dest` (temp file beside it,
   * then rename). `size`: the Boox file size, checked when > 0. Returns the
   * byte count; "missing" when the cloud has no file.
   */
  downloadBook(doc: CloudDoc, dest: string, size?: number): Promise<number>
}

// ---------------------------------------------------------------------------
// OSS (pure helpers)

/**
 * Moves a finished temp file to `dest` without replacing a valid copy
 * published meanwhile (one of `size` bytes; any copy when the size is
 * unknown, as the cache check reads it). The link fails if `dest` exists.
 */
export function publishFile(temp: string, dest: string, size?: number): void {
  try {
    linkSync(temp, dest)
    rmSync(temp, { force: true })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  let valid = false
  try {
    valid = !size || statSync(dest).size === size
  } catch {
    valid = false
  }
  if (valid) rmSync(temp, { force: true })
  else renameSync(temp, dest)
}

/** Largest book file downloaded, as for the ADB copy (its 512 MiB buffer). */
export const MAX_BOOK_FILE = 512 * 1024 * 1024

export type StsCredentials = { AccessKeyId: string; AccessKeySecret: string; SecurityToken: string; Expiration: string }
export type OssBucket = { bucket: string; endpoint: string }

const SAFE_ID = /^[A-Za-z0-9_-]+$/
/** Object key of a book file; undefined when an id would escape its path segment. */
export function ossBookKey(uid: string, uniqueId: string, type: string): string | undefined {
  if (!SAFE_ID.test(uid) || !SAFE_ID.test(uniqueId) || !/^[a-z0-9]+$/.test(type)) return undefined
  return `${uid}/reader/${uniqueId}/book/${uniqueId}.${type}`
}

/** OSS V1 string to sign for a GET or HEAD with an STS token (no Content-MD5, no Content-Type). */
export function ossStringToSign(verb: "GET" | "HEAD", date: string, securityToken: string, bucket: string, key: string): string {
  return `${verb}\n\n\n${date}\nx-oss-security-token:${securityToken}\n/${bucket}/${key}`
}

export function ossSignature(secret: string, stringToSign: string): string {
  return createHmac("sha1", secret).update(stringToSign, "utf8").digest("base64")
}

/** URL and signed headers of an object request. */
export function ossRequest(verb: "GET" | "HEAD", credentials: StsCredentials, bucket: OssBucket, key: string, now: Date) {
  const date = now.toUTCString()
  const signature = ossSignature(credentials.AccessKeySecret, ossStringToSign(verb, date, credentials.SecurityToken, bucket.bucket, key))
  return {
    url: `https://${bucket.bucket}.${bucket.endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`,
    headers: {
      Date: date,
      "x-oss-security-token": credentials.SecurityToken,
      Authorization: `OSS ${credentials.AccessKeyId}:${signature}`,
    },
  }
}

/** The `onyx-cloud` entry of `config/buckets` (the web app's default, also for EU accounts). */
export function ossBucketOf(buckets: unknown): OssBucket | undefined {
  const entry = (buckets as Record<string, { bucket?: unknown; aliEndpoint?: unknown }> | undefined)?.["onyx-cloud"]
  const bucket = entry?.bucket
  const endpoint = entry?.aliEndpoint
  // Credentials are only ever sent to an Aliyun OSS host.
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) return undefined
  if (typeof endpoint !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.aliyuncs\.com$/.test(endpoint)) return undefined
  return { bucket, endpoint }
}

/**
 * Makes one of our files readable by the user only. `writeFileSync`'s mode
 * applies to new files only, so existing ones (or a token file the user
 * created 0644) are fixed here, on every read and write.
 */
export function makePrivate(file: string): void {
  try {
    if (statSync(file).mode & 0o077) chmodSync(file, 0o600)
  } catch {
    // Missing file, or not ours to change.
  }
}

export const defaultBackupFile = (dataDir = defaultDataDir()) => join(dataDir, "onyx-backups.json")
export const BACKUPS_KEPT = 20

/** Keeps a doc as it was before a push, in a ring of the last `keep` (0600 JSON file). */
export function saveBackup(file: string, doc: CloudDoc, now: number, keep = BACKUPS_KEPT): void {
  let ring: unknown[] = []
  try {
    const old: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (Array.isArray(old)) ring = old
  } catch {
    ring = []
  }
  ring.push({ at: now, id: doc._id, rev: doc._rev, doc })
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  makePrivate(file) // Before writing the new content into an existing file.
  writeFileSync(file, JSON.stringify(ring.slice(-keep)), { mode: 0o600 })
  makePrivate(file)
}

/** Session ids are refreshed this long before they expire. */
const MARGIN_MS = 60 * 60_000

/** The token, without quotes or blanks; a token file readable by others is made 0600 first. */
export function readToken(file: string): string | undefined {
  makePrivate(file)
  try {
    const token = readFileSync(file, "utf8").trim().replace(/^(["'])(.*)\1$/s, "$2").trim()
    return token || undefined
  } catch {
    return undefined
  }
}

/** Non-reversible token fingerprint stored with the session. */
export const tokenFingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16)

export function createOnyx(options: OnyxOptions = {}): Onyx {
  const endpoints = ENDPOINTS[options.server === "us" ? "us" : "eur"]
  const tokenFile = options.tokenFile ?? defaultTokenFile()
  const sessionFile = options.sessionFile ?? defaultSessionFile()
  const fetcher: Fetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 15_000
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 10 * 60_000
  let session: Session | undefined

  const request = async (url: string, init: RequestInit, timeout = timeoutMs): Promise<Response> => {
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) })
    } catch {
      throw new OnyxError("offline", "Onyx cloud unreachable")
    }
  }
  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json()
    } catch {
      throw new OnyxError("error", "Onyx cloud: invalid response")
    }
  }

  /** Usable: bought with this token on this server, and not about to expire. */
  const fresh = (s: Session | undefined, token: string): s is Session =>
    !!s &&
    typeof s.session_id === "string" &&
    typeof s.cookie_name === "string" &&
    s.server === endpoints.gateway &&
    s.token_sha === tokenFingerprint(token) &&
    Date.parse(s.expires) - now() > MARGIN_MS
  /** Forgets the session in memory and on disk. */
  const forget = () => {
    session = undefined
    try {
      rmSync(sessionFile, { force: true })
    } catch {
      // Nothing to forget.
    }
  }

  const store = (s: Session) => {
    session = s
    try {
      mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 })
      makePrivate(sessionFile)
      writeFileSync(sessionFile, JSON.stringify(s), { mode: 0o600 })
      makePrivate(sessionFile)
    } catch {
      // The in-memory session still works.
    }
  }

  const newSession = async (): Promise<Session> => {
    const token = readToken(tokenFile)
    if (!token) throw new OnyxError("off", "Onyx cloud not configured (see README)")
    const response = await request(`${endpoints.api}users/syncToken`, { headers: { Authorization: `Bearer ${token}` } })
    if (response.status === 401 || response.status === 403) throw new OnyxError("expired", EXPIRED_MESSAGE)
    if (!response.ok) throw new OnyxError("error", `Onyx cloud: HTTP ${response.status}`)
    const body = (await json(response)) as { result_code?: number; data?: Partial<Session> }
    const data = body?.data
    if (body?.result_code !== 0 || !data || typeof data.session_id !== "string" || typeof data.cookie_name !== "string")
      throw new OnyxError("expired", EXPIRED_MESSAGE)
    return {
      cookie_name: data.cookie_name,
      session_id: data.session_id,
      expires: String(data.expires ?? ""),
      channels: data.channels,
      server: endpoints.gateway,
      token_sha: tokenFingerprint(token),
    }
  }

  const current = async (): Promise<Session> => {
    const token = readToken(tokenFile)
    if (!token) {
      forget()
      throw new OnyxError("off", "Onyx cloud not configured (see README)")
    }
    if (fresh(session, token)) return session
    session = undefined
    makePrivate(sessionFile)
    try {
      const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as Session
      if (fresh(saved, token)) return (session = saved)
    } catch {
      // No usable saved session.
    }
    forget()
    const s = await newSession()
    store(s)
    return s
  }

  /** Gateway request with the session cookie; a 401 renews the session once. */
  const gateway = async (path: string, init: RequestInit = {}, timeout?: number): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const s = await current()
      const headers = { ...(init.headers as Record<string, string> | undefined), Cookie: `${s.cookie_name}=${s.session_id}` }
      const response = await request(endpoints.gateway + path, { ...init, headers }, timeout)
      if (response.status !== 401 || attempt > 0) return response
      session = undefined
      store(await newSession())
    }
  }

  const ok = async (response: Response): Promise<unknown> => {
    if (response.status === 401) throw new OnyxError("expired", EXPIRED_MESSAGE)
    if (response.status === 409) throw new OnyxError("conflict", "Onyx cloud: the book changed meanwhile")
    if (!response.ok) throw new OnyxError("error", `Onyx cloud: HTTP ${response.status}`)
    return json(response)
  }

  const userId = async (): Promise<string> => {
    const s = await current()
    if (s.user_id) return s.user_id
    const body = (await ok(await gateway("_session"))) as { userCtx?: { name?: unknown } }
    const name = body?.userCtx?.name
    if (typeof name !== "string" || !name) throw new OnyxError("expired", EXPIRED_MESSAGE)
    store({ ...(session ?? s), user_id: name })
    return name
  }

  /** Authenticated API GET (Bearer token); the token's refusal is "expired". */
  const api = async (path: string): Promise<unknown> => {
    const token = readToken(tokenFile)
    if (!token) throw new OnyxError("off", "Onyx cloud not configured (see README)")
    const response = await request(`${endpoints.api}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (response.status === 401 || response.status === 403) throw new OnyxError("expired", EXPIRED_MESSAGE)
    if (!response.ok) throw new OnyxError("error", `Onyx cloud: HTTP ${response.status}`)
    const body = (await json(response)) as { result_code?: number; data?: unknown }
    if (body?.result_code !== 0) throw new OnyxError("error", "Onyx cloud: request refused")
    return body.data
  }

  // STS credentials and the bucket: memory only, credentials until a minute before they expire.
  let sts: { credentials: StsCredentials; until: number; token: string } | undefined
  let bucket: OssBucket | undefined
  const credentials = async (): Promise<StsCredentials> => {
    const fingerprint = tokenFingerprint(readToken(tokenFile) ?? "")
    if (sts && sts.token === fingerprint && now() < sts.until) return sts.credentials
    sts = undefined
    const data = (await api("config/stss")) as Partial<StsCredentials> | undefined
    const fields = ["AccessKeyId", "AccessKeySecret", "SecurityToken", "Expiration"] as const
    if (!data || !fields.every((f) => typeof data[f] === "string" && data[f])) throw new OnyxError("error", "Onyx cloud: invalid storage credentials")
    const value = data as StsCredentials
    const until = Date.parse(value.Expiration) - 60_000
    if (!Number.isFinite(until)) throw new OnyxError("error", "Onyx cloud: invalid storage credentials")
    sts = { credentials: { AccessKeyId: value.AccessKeyId, AccessKeySecret: value.AccessKeySecret, SecurityToken: value.SecurityToken, Expiration: value.Expiration }, until, token: fingerprint }
    return sts.credentials
  }
  const ossBucket = async (): Promise<OssBucket> => {
    if (bucket) return bucket
    const found = ossBucketOf(await api("config/buckets"))
    if (!found) throw new OnyxError("error", "Onyx cloud: no file storage")
    return (bucket = found)
  }

  const downloadBook = async (doc: CloudDoc, dest: string, size = 0): Promise<number> => {
    const uid = await userId()
    const uniqueId = String(doc.uniqueId)
    if (doc.modeType !== 4 || doc.type !== "epub" || doc._id !== `${uid}#${uniqueId}`) throw new OnyxError("error", "not an EPUB book document")
    const key = ossBookKey(uid, uniqueId, "epub")
    if (!key) throw new OnyxError("error", "unexpected book id")
    const origin = typeof doc.fileOriginSize === "number" && doc.fileOriginSize > 0 ? doc.fileOriginSize : undefined
    const expected = origin ?? (size > 0 ? size : undefined)
    if ((origin && size > 0 && origin !== size) || (expected ?? 0) > MAX_BOOK_FILE) throw new OnyxError("error", "the cloud file is not the Boox file")
    const { url, headers } = ossRequest("GET", await credentials(), await ossBucket(), key, new Date(now()))
    const response = await request(url, { headers }, downloadTimeoutMs)
    if (response.status === 403 || response.status === 404) {
      void response.body?.cancel().catch(() => {})
      // 403 may also be credentials gone stale early: get new ones next time.
      if (response.status === 403) sts = undefined
      throw new OnyxError("missing", "book file not in the Onyx cloud")
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new OnyxError("error", `Onyx cloud storage: HTTP ${response.status}`)
    }
    const announced = Number(response.headers.get("content-length") ?? NaN)
    if (Number.isFinite(announced) && (announced > MAX_BOOK_FILE || (expected !== undefined && announced !== expected))) {
      void response.body.cancel().catch(() => {})
      throw new OnyxError("error", "the cloud file is not the Boox file")
    }

    mkdirSync(dirname(dest), { recursive: true })
    const partial = `${dest}.${randomBytes(4).toString("hex")}.part`
    const fd = openSync(partial, "w")
    let open = true
    const close = () => {
      if (open) closeSync(fd)
      open = false
    }
    let total = 0
    let head = Buffer.alloc(0)
    try {
      const reader = response.body.getReader()
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          throw new OnyxError("offline", "Onyx cloud download interrupted")
        }
        if (chunk.done) break
        total += chunk.value.length
        if (total > (expected ?? MAX_BOOK_FILE)) {
          void reader.cancel().catch(() => {})
          throw new OnyxError("error", "the cloud file is not the Boox file")
        }
        if (head.length < 2) head = Buffer.concat([head, Buffer.from(chunk.value.subarray(0, 2))]).subarray(0, 2)
        writeSync(fd, chunk.value)
      }
      close()
      if (expected !== undefined && total !== expected) throw new OnyxError("error", `incomplete download (${total} of ${expected} bytes)`)
      if (head.toString("latin1") !== "PK") throw new OnyxError("error", "the cloud file is not an EPUB")
      publishFile(partial, dest, total)
      return total
    } catch (error) {
      try {
        close()
      } finally {
        rmSync(partial, { force: true })
      }
      throw error instanceof OnyxError ? error : new OnyxError("error", "Onyx cloud download failed")
    }
  }

  return {
    configured: () => !!readToken(tokenFile),
    userId,
    downloadBook,
    async library() {
      const uid = await userId()
      const query = `filter=sync_gateway/bychannel&channels=${encodeURIComponent(`${uid}-READER_LIBRARY`)}&include_docs=true`
      const body = (await ok(await gateway(`_changes?${query}`, {}, 60_000))) as { results?: Array<{ doc?: CloudDoc; deleted?: boolean; removed?: unknown }> }
      if (!Array.isArray(body?.results)) throw new OnyxError("error", "Onyx cloud: invalid library")
      return body.results
        .filter((r) => !r.deleted && !r.removed && r.doc && !r.doc._deleted && typeof r.doc._id === "string")
        .map((r) => r.doc!)
    },
    async getDoc(id) {
      const doc = (await ok(await gateway(encodeURIComponent(id)))) as CloudDoc
      if (!doc || doc._id !== id) throw new OnyxError("error", "Onyx cloud: invalid document")
      return doc
    },
    async putDoc(doc) {
      const uid = await userId()
      if (doc.modeType !== 4 || typeof doc._rev !== "string" || doc._id !== `${uid}#${String(doc.uniqueId)}`)
        throw new OnyxError("error", "refused: only book documents with a revision are written")
      const response = await gateway(encodeURIComponent(doc._id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      })
      const body = (await ok(response)) as { rev?: unknown }
      return typeof body?.rev === "string" ? body.rev : ""
    },
  }
}
