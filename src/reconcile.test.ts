import { test } from "node:test"
import assert from "node:assert/strict"
import { pullDoc, pushDoc, readingPrint, reconcile, validMark, withBase, type Doc, type DocIo, type LocalReading } from "./sync.ts"

// A book doc as NeoReader leaves it: a v3 position (node `node` of chapter 1), progress, and its save time (device clock) when given.
const point = (node: number) => JSON.stringify({ chapterIndex: 1, nodePosition: node, textOffset: 0, chapterStartPosition: 1000, chapterEndPosition: 9000, xpath: [1, node] })
const bookDoc = (node: number, progress: string, rev: string, updateTime?: number, lastAccess = 0): Doc => ({
  _id: "u1#b", _rev: rev, modeType: 4, uniqueId: "b", status: 0, type: "epub", progress, lastAccess,
  extraAttributes: JSON.stringify({
    backend: { current_page_position_v3: point(node), ...(updateTime !== undefined ? { user_doc_data_update_time: updateTime } : {}), device_model: "Go7", total_page: 100 },
  }),
})

const CONFLICT = new Error("409")

/** A fake Onyx cloud holding one book doc, and the server's raw sync record for it (`raw`, undefined: `onyx-sync.json` missing). */
function fakeCloud(doc: Doc) {
  let revs = 1
  const cloud = {
    doc,
    raw: undefined as unknown,
    puts: 0,
    /** The next PUT is accepted but its answer is lost. */
    lose: false,
    /** The next PUT is refused: the doc changed meanwhile. */
    conflict: false,
    /** The Boox saves a reading. */
    booxSaves(node: number, progress = "50/100", updateTime?: number) {
      cloud.doc = bookDoc(node, progress, `${++revs}-b`, updateTime)
    },
    /** The Boox opens the book without reading: only `lastAccess` and `_rev` change. */
    booxOpens(lastAccess: number) {
      cloud.doc = { ...cloud.doc, lastAccess, _rev: `${++revs}-o` }
    },
  }
  const io: DocIo = {
    getDoc: async () => structuredClone(cloud.doc),
    putDoc: async (next) => {
      if (cloud.conflict || next._rev !== cloud.doc._rev) {
        cloud.conflict = false
        throw CONFLICT
      }
      cloud.doc = { ...next, _rev: `${++revs}-p` }
      cloud.puts++
      if (cloud.lose) {
        cloud.lose = false
        throw new Error("socket hang up")
      }
      return String(cloud.doc._rev)
    },
    isConflict: (error) => error === CONFLICT,
    mark: () => validMark(cloud.raw),
    setMark: (mark) => void (cloud.raw = mark),
    backup: () => {},
    toLocal: (p) => ({ spine: p.chapterIndex, offset: p.nodePosition, exact: true }),
    toNeo: (l) => ({ chapterIndex: l.spine, nodePosition: l.offset, textOffset: 0, xpath: [1, l.offset] }),
    now: () => 10_000,
  }
  const local = (node: number, turnedAt: number, percent = 30, finished = false): LocalReading => ({ position: { spine: 1, offset: node }, percent, finished, turnedAt })
  return {
    cloud,
    io,
    local,
    pull: (l: LocalReading) => pullDoc(io, l),
    push: (l: LocalReading, force?: string) => pushDoc(io, l, force),
    /** What the TUI does after applying a pulled position at `turnedAt` (the `agree` RPC). */
    agree: (pulled: { rev: string; print: string }, turnedAt: number) => io.setMark(withBase(io.mark(), { rev: pulled.rev, print: pulled.print, localAt: turnedAt })),
  }
}

/** Opened here for the first time (nothing read yet): the Boox position is pulled and applied at 1000. */
async function adopted(doc: Doc) {
  const f = fakeCloud(doc)
  const first = await f.pull(f.local(0, 0))
  assert.equal(first.action, "pull")
  f.agree(first, 1_000)
  return f
}

test("reconcile: automatic only when one side changed, asked when both or when nothing is known", () => {
  const base = { rev: "5-a", print: "A", localAt: 100 }
  const at = (rev: string, print: string, extra: { same?: boolean; positioned?: boolean } = {}) => ({ rev, print, positioned: true, same: false, ...extra })
  const rows: Array<[string, ReturnType<typeof reconcile>["action"], ReturnType<typeof reconcile>["action"]]> = [
    ["neither changed", reconcile(at("5-a", "A"), { base }, 100).action, "none"],
    ["only local", reconcile(at("5-a", "A"), { base }, 200).action, "push"],
    ["only cloud", reconcile(at("6-b", "B"), { base }, 100).action, "pull"],
    ["both", reconcile(at("6-b", "B"), { base }, 200).action, "ask"],
    ["a new revision, same reading (opened on the Boox)", reconcile(at("6-o", "A"), { base }, 200).action, "push"],
    ["the same revision with another print (not a change)", reconcile(at("5-a", "B"), { base }, 100).action, "none"],
    ["no base, read here", reconcile(at("6-b", "B"), {}, 200).action, "ask"],
    ["no base, nothing read here", reconcile(at("6-b", "B"), {}, 0).action, "pull"],
    ["no cloud position, read here", reconcile(at("6-b", "B", { positioned: false }), {}, 200).action, "push"],
    ["no cloud position, nothing read", reconcile(at("6-b", "B", { positioned: false }), {}, 0).action, "none"],
  ]
  for (const [name, got, want] of rows) assert.equal(got, want, name)
  // The same position on both sides: agreed, whatever else is known.
  assert.deepEqual(reconcile(at("6-b", "B", { same: true }), {}, 200), { action: "none", base: { rev: "6-b", print: "B", localAt: 200 } })
  assert.deepEqual(reconcile(at("6-b", "B", { same: true }), { base }, 300), { action: "none", base: { rev: "6-b", print: "B", localAt: 300 } })
  // Our attempt in the cloud (answer lost): the base while nothing was read here since; else the Boox may have written it: ask.
  const attempt = { print: "W", localAt: 150 }
  assert.deepEqual(reconcile(at("6-p", "W"), { base, attempt }, 150), { action: "none", base: { rev: "6-p", print: "W", localAt: 150 } })
  assert.deepEqual(reconcile(at("6-p", "W"), { base, attempt }, 180), { action: "ask" })
  // Already the base revision: not taken again.
  assert.deepEqual(reconcile(at("5-a", "W"), { base, attempt }, 100), { action: "none" })
})

test("a reading print is the position only: not _rev, lastAccess, update times, progress or the chapter's byte range", () => {
  const doc = bookDoc(120, "20/100", "1-a", 5)
  const print = readingPrint(doc)
  assert.equal(readingPrint({ ...doc, _rev: "9-z", lastAccess: 99, updatedAt: 99 }), print)
  assert.equal(readingPrint(bookDoc(120, "21/100", "2-b", 77)), print)
  assert.equal(readingPrint({ ...doc, extraAttributes: String(doc.extraAttributes).replace("1000", "1200") }), print)
  assert.notEqual(readingPrint(bookDoc(121, "20/100", "1-a", 5)), print)
})

test("an invalid sync record reads as no base and no attempt, never throws", () => {
  for (const junk of [null, 3, "x", [], { writes: [null] }, { base: { rev: 3, print: "A", localAt: 1 } }, { base: { rev: "1", print: "A", localAt: -1 } }, { base: null, attempt: { print: 1 } }])
    assert.deepEqual(validMark(junk), {})
  assert.deepEqual(validMark({ base: { rev: "1", print: "A", localAt: 5 }, attempt: { print: "B" } }), { base: { rev: "1", print: "A", localAt: 5 } })
})

test("a corrupt onyx-sync.json: no throw, the reader is asked", async () => {
  const f = fakeCloud(bookDoc(100, "20/100", "1-a"))
  f.cloud.raw = { writes: [null], base: { rev: 1, print: [], localAt: "x" } }
  assert.equal((await f.pull(f.local(300, 2_000))).action, "ask")
  assert.deepEqual(await f.push(f.local(300, 2_000)), { pushed: false, action: "ask" })
  assert.equal(f.cloud.puts, 0)
})

test("blocker: the Boox going back to a position we once wrote is pulled", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  assert.equal((await f.push(f.local(300, 2_000))).pushed, true)
  assert.equal((await f.push(f.local(400, 3_000))).pushed, true)
  f.cloud.booxSaves(300)
  const pulled = await f.pull(f.local(400, 3_000))
  assert.deepEqual([pulled.action, pulled.offset], ["pull", 300])
  assert.deepEqual(await f.push(f.local(400, 3_000)), { pushed: false, action: "pull", agreedAt: 3_000 })
})

test("blocker: a window holding an older reading overwrites neither the stored one nor the cloud", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  await f.push(f.local(300, 2_000)) // Both windows were there.
  f.cloud.booxSaves(500)
  // Window A applies the Boox position at 5000.
  const pulled = await f.pull(f.local(300, 2_000))
  assert.equal(pulled.action, "pull")
  f.agree(pulled, 5_000)
  // Window B closes on its reading of 2000: nothing sent, the Boox position stays.
  assert.deepEqual(await f.push(f.local(300, 2_000)), { pushed: false, action: "none", agreedAt: 5_000 })
  assert.equal(f.cloud.puts, 1)
  assert.equal(readingPrint(f.cloud.doc), pulled.print)
})

test("blocker: a lost agree then a page turn asks, never pulls silently; without a turn both sides agree", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  f.cloud.booxSaves(500)
  assert.equal((await f.pull(f.local(100, 1_000))).action, "pull")
  // Applied here at 5000, but the agree is lost.
  assert.deepEqual(await f.push(f.local(500, 5_000, 50)), { pushed: false, action: "none", agreedAt: 5_000 })
  const g = await adopted(bookDoc(100, "20/100", "1-a"))
  g.cloud.booxSaves(500)
  await g.pull(g.local(100, 1_000))
  // Applied at 5000 (agree lost), then a page turn at 6000.
  assert.deepEqual(await g.push(g.local(600, 6_000)), { pushed: false, action: "ask", agreedAt: 1_000 })
  assert.equal((await g.pull(g.local(600, 6_000))).action, "ask")
  assert.equal(g.cloud.puts, 0)
})

test("blocker: a missing or skewed Boox save time changes nothing", async () => {
  for (const updateTime of [undefined, 1, 10 ** 13]) {
    const f = await adopted(bookDoc(100, "20/100", "1-a", updateTime))
    assert.equal((await f.push(f.local(300, 2_000))).pushed, true)
    f.cloud.booxSaves(500, "50/100", updateTime)
    assert.equal((await f.pull(f.local(300, 2_000))).action, "pull")
    assert.equal((await f.pull(f.local(350, 3_000))).action, "ask")
  }
})

test("the Boox opening the book (lastAccess and _rev only) leaves the local reading to push", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a", 2_000))
  f.cloud.booxOpens(9_000)
  assert.equal((await f.pull(f.local(300, 5_000))).action, "push")
  assert.deepEqual(await f.push(f.local(300, 5_000)), { pushed: true, at: 10_000, progress: "30/100", agreedAt: 5_000 })
})

test("our PUT accepted, its answer lost: agreed while nothing was read since, asked after a page turn", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  f.cloud.lose = true
  await assert.rejects(f.push(f.local(300, 2_000)), /socket hang up/)
  assert.equal(f.cloud.puts, 1)
  assert.equal((await f.pull(f.local(300, 2_000))).action, "none")
  assert.deepEqual(validMark(f.cloud.raw), { base: { rev: String(f.cloud.doc._rev), print: readingPrint(f.cloud.doc), localAt: 2_000 } })
  const g = await adopted(bookDoc(100, "20/100", "1-a"))
  g.cloud.lose = true
  await assert.rejects(g.push(g.local(300, 2_000)), /socket hang up/)
  assert.deepEqual(await g.push(g.local(350, 3_000)), { pushed: false, action: "ask", agreedAt: 1_000 })
  assert.equal(g.cloud.puts, 1)
})

test("an attempt matched after reading on is no proof it is ours: the Boox writing the same reading asks", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  f.cloud.lose = true
  await assert.rejects(f.push(f.local(300, 2_000)), /socket hang up/)
  const ours = structuredClone(f.cloud.doc)
  f.cloud.booxSaves(100) // The Boox read elsewhere, then really wrote the reading A again.
  f.cloud.doc = { ...ours, _rev: "7-b" }
  assert.equal((await f.pull(f.local(350, 3_000))).action, "ask")
  assert.deepEqual(await f.push(f.local(350, 3_000)), { pushed: false, action: "ask", agreedAt: 1_000 })
  assert.equal(f.cloud.puts, 1)
})

test("a stale agree does not lower the base: a window holding an older reading never pushes", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  assert.equal((await f.push(f.local(300, 3_000))).pushed, true)
  f.agree({ rev: "1-a", print: readingPrint(bookDoc(100, "20/100", "1-a")) }, 1_000)
  assert.equal(validMark(f.cloud.raw).base?.localAt, 3_000)
  const held = await f.push(f.local(200, 2_000))
  assert.equal(held.pushed, false)
  assert.ok(!held.pushed && (held.action === "ask" || held.action === "none"))
  assert.equal(f.cloud.puts, 1)
})

test("no base: asked when read on both sides, agreed when at the same position", async () => {
  const f = fakeCloud(bookDoc(100, "20/100", "1-a"))
  assert.equal((await f.pull(f.local(300, 2_000))).action, "ask")
  assert.deepEqual(await f.push(f.local(300, 2_000)), { pushed: false, action: "ask" })
  const g = fakeCloud(bookDoc(100, "20/100", "1-a"))
  const same = await g.pull(g.local(100, 2_000))
  assert.deepEqual([same.action, same.agreedAt], ["none", 2_000])
  assert.deepEqual(validMark(g.cloud.raw).base, { rev: "1-a", print: readingPrint(g.cloud.doc), localAt: 2_000 })
})

test("keeping this computer's reading is a forced push over the revision shown; a 409 asks again", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  f.cloud.booxSaves(500)
  const shown = (await f.pull(f.local(300, 2_000))).rev
  f.cloud.conflict = true
  assert.deepEqual(await f.push(f.local(300, 2_000), shown), { pushed: false, action: "ask" })
  assert.deepEqual(await f.push(f.local(300, 2_000), shown), { pushed: true, at: 10_000, progress: "30/100", agreedAt: 2_000 })
  assert.equal((await f.pull(f.local(300, 2_000))).action, "none")
})

test("the Boox moving between the question and the choice: the forced push asks again, writes nothing", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  f.cloud.booxSaves(500)
  const shown = await f.pull(f.local(300, 2_000))
  assert.equal(shown.action, "ask")
  f.cloud.booxSaves(600)
  assert.deepEqual(await f.push(f.local(300, 2_000), shown.rev), { pushed: false, action: "ask" })
  assert.equal(f.cloud.puts, 0)
})

test("a book is finished (total/total) only by the push of a forward turn onto the last screen", async () => {
  const f = await adopted(bookDoc(100, "20/100", "1-a"))
  // On the last screen, not finished (opened there, or back then forward without the finishing turn).
  assert.equal((await f.push(f.local(9_000, 2_000, 100, false))).pushed, true)
  assert.equal(f.cloud.doc.progress, "99/100")
  // The forward turn onto it: same position, now finished: written.
  assert.equal((await f.push(f.local(9_000, 3_000, 100, true))).pushed, true)
  assert.equal(f.cloud.doc.progress, "100/100")
  assert.deepEqual(await f.push(f.local(9_000, 3_000, 100, true)), { pushed: false, action: "none", agreedAt: 3_000 })
  assert.equal(f.cloud.puts, 2)
})

test("a cloud doc with no reading position is not written", async () => {
  const f = fakeCloud({ ...bookDoc(100, "20/100", "1-a"), extraAttributes: JSON.stringify({ backend: { total_page: 100 } }) })
  assert.equal((await f.pull(f.local(300, 2_000))).action, "push")
  await assert.rejects(f.push(f.local(300, 2_000)), /no reading position in the cloud yet/)
  assert.equal(f.cloud.puts, 0)
})
