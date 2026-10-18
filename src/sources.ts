/**
 * Where a book file not yet on this Mac comes from: the copy the Boox
 * uploaded to the Onyx cloud first (no cable), then ADB.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { AdbError } from "./adb.ts"
import { EXPIRED_MESSAGE, OnyxError, publishFile } from "./onyx.ts"

export const NOT_HERE = "Not on this Mac: on the Boox, long-press the book → Upload source file (or plug the Boox in)"

/** `expired`: the cloud refused the token (whatever ADB did). */
export type Obtained = { ok: true; source: "cloud" | "adb"; expired?: true } | { ok: false; error: string; notHere?: true; expired?: true }

/**
 * Tries the cloud download (when configured), then the ADB copy. A missing,
 * refused or unreachable source falls through quietly to the next one; with
 * none left, an expired token keeps its message, otherwise `NOT_HERE`.
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
  // A cloud file that failed its checks (size, not a ZIP) is worth saying.
  if (cloud?.state === "error") return { ok: false, error: `${NOT_HERE}. Onyx cloud: ${cloud.message}`, notHere: true }
  return { ok: false, error: NOT_HERE, notHere: true }
}

export type Fetched = { ok: true; source: "cache" | "cloud" | "adb"; expired?: true } | { ok: false; error: string; notHere?: true; expired?: true }

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
    mkdirSync(dirname(file), { recursive: true })
    const download = useCloud ? deps.cloud() : undefined
    const fromBoox = async () => {
      const temp = `${file}.${randomBytes(4).toString("hex")}.part`
      try {
        await deps.pull(booxPath, temp)
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
