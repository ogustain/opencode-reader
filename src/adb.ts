/**
 * Read-only access to the Boox library over ADB.
 *
 * `adb` runs through `execFile`, never a host shell. `adb shell` and
 * `adb exec-out` join their arguments into one device shell command line, so
 * every device path is single-quoted there; `adb pull` takes the path as is.
 * Nothing here writes to the device: no `content update/insert/delete`, no
 * `am`, no push.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const METADATA_URI = "content://com.onyx.content.database.ContentProvider/Metadata"
export const PROJECTION = ["id", "title", "authors", "name", "nativeAbsolutePath", "size", "lastAccess", "progress"] as const

export type BooxBook = {
  id: string
  title: string
  authors?: string
  name: string
  path: string
  size: number
  /** Epoch ms of the last read on the Boox, 0 when never opened. */
  lastAccess: number
  current?: number
  total?: number
  /** current / total × 100 */
  percent?: number
}

export type AdbState = "ok" | "missing" | "none" | "unauthorized" | "offline" | "error"
export type AdbStatus = { state: AdbState; message: string; serial?: string }

/** Single-quotes a word for the device's sh: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Rows of `content query` output. Values may hold commas and newlines; `NULL` → null. */
export function parseRows(output: string, keys: readonly string[] = PROJECTION): Array<Record<string, string | null>> {
  const rows: string[] = []
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    if (/^Row: \d+ /.test(line)) rows.push(line.replace(/^Row: \d+ /, ""))
    else if (rows.length > 0 && line) rows[rows.length - 1] += `\n${line}`
  }
  return rows.map((row) => {
    // Locate each known key at the row start or after ", ", in order of appearance.
    const found: Array<{ key: string; at: number; value: number }> = []
    let from = 0
    for (const key of keys) {
      let at = 0
      let value = key.length + 1
      if (!(from === 0 && row.startsWith(`${key}=`))) {
        at = row.indexOf(`, ${key}=`, from)
        if (at < 0) continue
        value = at + key.length + 3
      }
      found.push({ key, at, value })
      from = value
    }
    const record: Record<string, string | null> = {}
    found.forEach((f, i) => {
      const raw = row.slice(f.value, i + 1 < found.length ? found[i + 1].at : row.length)
      record[f.key] = raw === "NULL" ? null : raw
    })
    return record
  })
}

export function parseProgress(value: string | null | undefined): { current: number; total: number } | undefined {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value ?? "")
  if (!m) return undefined
  const current = Number(m[1])
  const total = Number(m[2])
  return total > 0 ? { current: Math.min(current, total), total } : undefined
}

/** EPUB rows only; the title falls back to the file name. */
export function booxBooks(rows: Array<Record<string, string | null>>): BooxBook[] {
  const books: BooxBook[] = []
  for (const row of rows) {
    const path = row.nativeAbsolutePath ?? ""
    const name = row.name || path.split("/").pop() || ""
    if (!/\.epub$/i.test(path || name) || !path) continue
    const progress = parseProgress(row.progress)
    const lastAccess = Number(row.lastAccess)
    books.push({
      id: row.id ?? path,
      title: row.title?.trim() || name.replace(/\.epub$/i, ""),
      ...(row.authors?.trim() ? { authors: row.authors.trim() } : {}),
      name,
      path,
      size: Number(row.size) || 0,
      lastAccess: Number.isFinite(lastAccess) && lastAccess > 0 ? lastAccess : 0,
      ...(progress ? { ...progress, percent: (progress.current / progress.total) * 100 } : {}),
    })
  }
  return books
}

export function parseDevices(output: string): Array<{ serial: string; state: string }> {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([serial, state]) => ({ serial, state }))
}

/** `adb` from the option, PATH, or the usual install places (the server may lack Homebrew in PATH). */
export function findAdb(option?: unknown): string {
  if (typeof option === "string" && option) return option
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "adb"))) return join(dir, "adb")
  for (const path of ["/opt/homebrew/bin/adb", "/usr/local/bin/adb", join(homedir(), "Library/Android/sdk/platform-tools/adb")])
    if (existsSync(path)) return path
  return "adb"
}

type Run = (args: string[], options: { timeout: number }) => Promise<Buffer>

export class AdbError extends Error {
  readonly state: AdbState
  constructor(state: AdbState, message: string) {
    super(message)
    this.state = state
  }
}

export function runner(bin: string): Run {
  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: options.timeout, encoding: "buffer", maxBuffer: 512 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout)
          const text = `${stderr.toString("utf8")} ${error.message}`
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            reject(new AdbError("missing", "adb not found (brew install --cask android-platform-tools)"))
          else if (error.killed || /timed? ?out/i.test(text)) reject(new AdbError("offline", "Boox not responding (asleep?)"))
          else if (/unauthorized/i.test(text)) reject(new AdbError("unauthorized", "Boox not authorized: accept the USB debugging prompt"))
          else if (/no devices|device .* not found|offline/i.test(text)) reject(new AdbError("none", "Boox not connected"))
          else reject(new AdbError("error", text.trim().split("\n")[0].slice(0, 200)))
        },
      )
    })
}

export type Adb = {
  status(): Promise<AdbStatus>
  listBooks(): Promise<BooxBook[]>
  /** Copies a device file to `local`: `adb pull`, then `exec-out cat` if pull fails. */
  pull(remote: string, local: string): Promise<void>
}

export function createAdb(options: { bin?: unknown; serial?: unknown; run?: Run } = {}): Adb {
  const run = options.run ?? runner(findAdb(options.bin))
  const wanted = typeof options.serial === "string" && options.serial ? options.serial : undefined

  const device = async (): Promise<string> => {
    const devices = parseDevices((await run(["devices"], { timeout: 5_000 })).toString("utf8"))
    const candidates = wanted ? devices.filter((d) => d.serial === wanted) : devices
    const ready = candidates.find((d) => d.state === "device")
    if (ready) return ready.serial
    if (candidates.some((d) => d.state === "unauthorized"))
      throw new AdbError("unauthorized", "Boox not authorized: accept the USB debugging prompt")
    if (candidates.some((d) => d.state === "offline")) throw new AdbError("offline", "Boox offline (asleep?)")
    throw new AdbError("none", "Boox not connected")
  }

  return {
    async status() {
      try {
        const serial = await device()
        return { state: "ok", message: "Boox connected", serial }
      } catch (error) {
        return error instanceof AdbError ? { state: error.state, message: error.message } : { state: "error", message: String(error) }
      }
    },
    async listBooks() {
      const serial = await device()
      const out = await run(
        ["-s", serial, "shell", "content", "query", "--uri", METADATA_URI, "--projection", PROJECTION.join(":")],
        { timeout: 15_000 },
      )
      const text = out.toString("utf8")
      if (/^Error|Exception/m.test(text) && !/^Row:/m.test(text)) throw new AdbError("error", "NeoReader library unavailable")
      return booxBooks(parseRows(text))
    },
    async pull(remote, local) {
      const serial = await device()
      try {
        await run(["-s", serial, "pull", remote, local], { timeout: 120_000 })
        if (existsSync(local)) return
      } catch (error) {
        if (error instanceof AdbError && error.state !== "error") throw error
        // A stale library row: NeoReader still lists a file that was deleted.
        if (/no such file|failed to stat|does not exist/i.test(String((error as Error).message)))
          throw new AdbError("error", "file no longer on the Boox")
      }
      // exec-out exits 0 and prints cat's error on stdout: accept only a ZIP.
      const data = await run(["-s", serial, "exec-out", "cat", shellQuote(remote)], { timeout: 120_000 })
      if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new AdbError("error", "copy from the Boox failed")
      await writeFile(local, data)
    },
  }
}
