import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AdbError, booxBooks, createAdb, parseDevices, parseProgress, parseRows, shellQuote } from "./adb.ts"

test("single quotes survive the device shell", () => {
  assert.equal(shellQuote("a b"), "'a b'")
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  // Round trip through a POSIX sh, as `adb shell` does on the device.
  for (const value of ["/sdcard/Books/L’été d'un \"homme\" $HOME `x` ; rm -rf.epub", "''", "a\\b", "é & | < >"]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`]).toString("utf8"), value)
  }
})

const output = [
  "Row: 0 id=1, title=Un livre, avec virgule, authors=Anne A, name=un livre.epub, nativeAbsolutePath=/storage/emulated/0/Books/un livre.epub, size=91089, lastAccess=1792193271075, progress=129/129",
  "Row: 1 id=2, title=NULL, authors=NULL, name=Doc.pdf, nativeAbsolutePath=/storage/emulated/0/Books/Doc.pdf, size=10, lastAccess=17, progress=216/304",
  "Row: 2 id=3, title=NULL, authors=NULL, name=Sans titre.EPUB, nativeAbsolutePath=/storage/emulated/0/Books/Sans titre.EPUB, size=1757265, lastAccess=NULL, progress=NULL",
  "Row: 3 id=4, title=Deux",
  "lignes, authors=B, name=d.epub, nativeAbsolutePath=/storage/emulated/0/d.epub, size=5, lastAccess=0, progress=97/622",
  "",
].join("\n")

test("parses content query rows: commas in values, NULL, multi-line values", () => {
  const rows = parseRows(output)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].title, "Un livre, avec virgule")
  assert.equal(rows[0].authors, "Anne A")
  assert.equal(rows[0].progress, "129/129")
  assert.equal(rows[1].title, null)
  assert.equal(rows[2].lastAccess, null)
  assert.equal(rows[3].title, "Deux\nlignes")
  assert.equal(rows[3].progress, "97/622")
})

test("keeps EPUBs, falls back to the file name, computes the Boox %", () => {
  const books = booxBooks(parseRows(output))
  assert.deepEqual(
    books.map((b) => [b.title, b.percent === undefined ? undefined : Math.round(b.percent * 10) / 10, b.lastAccess]),
    [["Un livre, avec virgule", 100, 1792193271075], ["Sans titre", undefined, 0], ["Deux\nlignes", 15.6, 0]],
  )
  assert.equal(books[0].size, 91089)
  assert.equal(books[1].authors, undefined)
})

test("progress and device list parsing", () => {
  assert.deepEqual(parseProgress("97/622"), { current: 97, total: 622 })
  assert.equal(parseProgress("0/0"), undefined)
  assert.equal(parseProgress(null), undefined)
  assert.deepEqual(parseDevices("List of devices attached\nabc\tdevice usb:1 model:Go7\nxyz\tunauthorized\n\n"), [
    { serial: "abc", state: "device" },
    { serial: "xyz", state: "unauthorized" },
  ])
})

test("degrades quietly without a ready device and only runs read commands", async () => {
  const calls: string[][] = []
  const fake = (devices: string) =>
    createAdb({
      run: async (args) => {
        calls.push(args)
        if (args[0] === "devices") return Buffer.from(`List of devices attached\n${devices}\n`)
        return Buffer.from(output)
      },
    })
  assert.deepEqual(await fake("").status(), { state: "none", message: "Boox not connected" })
  assert.equal((await fake("abc\tunauthorized").status()).state, "unauthorized")
  await assert.rejects(fake("abc\toffline").listBooks(), (e: unknown) => e instanceof AdbError && e.state === "offline")
  const books = await fake("abc\tdevice").listBooks()
  assert.equal(books.length, 3)
  for (const args of calls.filter((a) => a[0] !== "devices")) {
    assert.deepEqual(args.slice(0, 5), ["-s", "abc", "shell", "content", "query"])
    assert.ok(!args.some((a) => /^(update|insert|delete|push|am)$/.test(a)))
  }
})

test("pull falls back to exec-out cat with a quoted path, and accepts only a ZIP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-reader-adb-"))
  const remote = "/sdcard/Books/L’été d'un homme.epub"
  const calls: string[][] = []
  const fake = (pull: () => Buffer, cat: Buffer) =>
    createAdb({
      run: async (args) => {
        calls.push(args)
        if (args[0] === "devices") return Buffer.from("List of devices attached\nabc\tdevice\n")
        if (args[2] === "pull") return pull()
        return cat
      },
    })
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
  const failPull = () => {
    throw new AdbError("error", "adb: error: remote read failed")
  }
  await fake(failPull, zipBytes).pull(remote, join(dir, "a.epub"))
  assert.deepEqual(await readFile(join(dir, "a.epub")), zipBytes)
  assert.deepEqual(calls.find((a) => a[2] === "pull"), ["-s", "abc", "pull", remote, join(dir, "a.epub")])
  assert.deepEqual(calls.find((a) => a[2] === "exec-out"), ["-s", "abc", "exec-out", "cat", `'/sdcard/Books/L’été d'\\''un homme.epub'`])
  await assert.rejects(fake(failPull, Buffer.from("cat: No such file or directory")).pull(remote, join(dir, "b.epub")), /copy from the Boox failed/)
  const gone = () => {
    throw new AdbError("error", "adb: error: failed to stat remote object: No such file or directory")
  }
  await assert.rejects(fake(gone, zipBytes).pull(remote, join(dir, "c.epub")), /no longer on the Boox/)
})
