/**
 * Where a book file not yet on this computer comes from: the copy the Boox
 * uploaded to the Onyx cloud first (no cable), then ADB.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { AdbError } from "./adb.ts"
import { EXPIRED_MESSAGE, OnyxError, publishFile } from "./onyx.ts"

export const NOT_HERE = "Not on this computer: on the Boox, long-press the book → Upload source file (or plug the Boox in)"

/** `expired`: the cloud refused the token (whatever ADB did). */
export type Obtained = { ok: true; source: "cloud" | "adb"; expired?: true } | { ok: false; error: string; notHere?: true; expired?: true }

/**
 * Tries the cloud download (when configured), then the ADB copy. A missing,
 * refused or unreachable source falls through quietly to the next one. With
 * none left: an expired token keeps its message; a file the cloud does not
 * have (or no cloud) is `NOT_HERE` (`notHere`); a cloud unreachable or in
 * error says so, as it may well have the file.
 */
export async function obtainBook(sources: { cloud?: () => Promise<unknown>; adb: () => Promise<unknown> }): Promise<Obtained> {
  let cloud: OnyxError | undefined
  if (sources.cloud) {
    try {
      await sources.cloud()
      return { ok: true, source: "cloud" }
    } catch (error) {
      cloud = error instanceof OnyxError ? error : new OnyxError("error", "Onyx cloud download failed")
    }
  }
  const expired = cloud?.state === "expired" ? ({ expired: true } as const) : {}
  try {
    await sources.adb()
    return { ok: true, source: "adb", ...expired }
  } catch (error) {
    const state = error instanceof AdbError ? error.state : undefined
    // No Boox reachable over USB: report on the cloud instead. Anything else (unauthorized, bad copy) is the answer.
    if (state !== "none" && state !== "offline" && state !== "missing") return { ok: false, error: error instanceof Error ? error.message : String(error), ...expired }
  }
  if (cloud?.state === "expired") return { ok: false, error: EXPIRED_MESSAGE, expired: true }
  if (!cloud || cloud.state === "missing" || cloud.state === "off") return { ok: false, error: NOT_HERE, notHere: true }
  // Unreachable, an HTTP error, a file that failed its checks: not "not uploaded".
  return { ok: false, error: cloud.state === "offline" ? `offline: ${cloud.message}` : cloud.message }
}

export type Fetched = { ok: true; source: "cache" | "cloud" | "adb"; expired?: true } | { ok: false; error: string; notHere?: true; expired?: true }

/** Cached book files (by resolved path): the Boox path and size of each. */
export type CacheManifest = Record<string, { booxPath: string; size: number }>

/** The manifest without the copies that are gone or empty (deleted or truncated since). */
export function liveCopies(manifest: CacheManifest): CacheManifest {
  return Object.fromEntries(
    Object.entries(manifest).filter(([file]) => {
      try {
        return statSync(file).size > 0
      } catch {
        return false
      }
    }),
  )
}

/** The cached copy counts when it has the Boox size (any copy when the size is unknown). */
export function isCached(file: string, size: number): boolean {
  try {
    return statSync(file).size === size || size === 0
  } catch {
    return false
  }
}

/**
 * Gets a Boox book file into the cache at `file`. Calls for the same file
 * while one runs share it; the cache is checked again inside, each copy uses
 * its own temp file, and a valid copy published meanwhile is never replaced.
 */
export function createFetcher(deps: {
  /** Cloud download to `file` (temp file, then `publishFile`); undefined when the cloud is not configured. */
  cloud: () => ((booxPath: string, file: string, size: number) => Promise<unknown>) | undefined
  pull: (booxPath: string, local: string) => Promise<void>
}): (booxPath: string, file: string, size: number, options?: { cloud?: boolean }) => Promise<Fetched> {
  const running = new Map<string, Promise<Fetched>>()
  const fetchOnce = async (booxPath: string, file: string, size: number, useCloud: boolean): Promise<Fetched> => {
    if (isCached(file, size)) return { ok: true, source: "cache" }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }) // The data dir and books/ are the user's only.
    const download = useCloud ? deps.cloud() : undefined
    const fromBoox = async () => {
      const temp = `${file}.${randomBytes(4).toString("hex")}.part`
      try {
        await deps.pull(booxPath, temp)
        chmodSync(temp, 0o600) // adb pull may keep the device's mode.
        const got = statSync(temp).size
        if (size > 0 && got !== size) throw new Error(`incomplete copy (${got} of ${size} bytes)`)
        publishFile(temp, file, size)
      } finally {
        rmSync(temp, { force: true }) // Unpublished (failed or partial) copy; gone already once published.
      }
    }
    return obtainBook({ ...(download ? { cloud: () => download(booxPath, file, size) } : {}), adb: fromBoox })
  }
  return (booxPath, file, size, options = {}) => {
    let job = running.get(file)
    if (!job) {
      job = fetchOnce(booxPath, file, size, options.cloud !== false).finally(() => running.delete(file))
      running.set(file, job)
    }
    return job
  }
}

/** Runs tasks one after another: each starts once the previous one settled. */
export function createLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}

/**
 * Reads shared while one runs, for a result that `forget` makes stale (the
 * cloud library of an account just disconnected): a read begun before
 * `forget` never reaches `publish`, and the next `ask` starts a new read
 * rather than wait for it.
 */
export function createFreshReads<T>(read: () => Promise<T>, publish: (result: T) => Promise<void>) {
  let generation = 0
  let running: Promise<void> | undefined
  return {
    ask(): Promise<void> {
      if (running) return running
      const at = generation
      const job: Promise<void> = read()
        .then((result) => (at === generation ? publish(result) : undefined))
        .finally(() => {
          // A newer read may run meanwhile: only this one is cleared.
          if (running === job) running = undefined
        })
      running = job
      return job
    },
    /** The read under way, if any. */
    pending: (): Promise<void> | undefined => running,
    forget() {
      generation++
      running = undefined
    },
  }
}
