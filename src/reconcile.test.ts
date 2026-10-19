import { test } from "node:test"
import assert from "node:assert/strict"
import { pullDoc, pushDoc, readingPrint, reconcile, withBase, withWrite, type CloudMark, type Doc, type DocIo, type LocalReading } from "./sync.ts"

// A book doc as NeoReader leaves it: a v3 position (node `node` of chapter 1), progress, its save time and device.
const point = (node: number) => JSON.stringify({ chapterIndex: 1, nodePosition: node, textOffset: 0, xpath: [1, node] })
const bookDoc = (node: number, progress: string, updateTime: number, device = "Go7", rev = "1-a", lastAccess = 0): Doc => ({
  _id: "u1#b", _rev: rev, modeType: 4, uniqueId: "b", status: 0, type: "epub", progress, lastAccess,
  extraAttributes: JSON.stringify({ backend: { current_page_position_v3: point(node), user_doc_data_update_time: updateTime, device_model: device, total_page: 100 } }),
})

const CONFLICT = new Error("409")

/** A fake Onyx cloud holding one book doc, and the server's sync record for it (`mark`, undefined: `onyx-sync.json` missing). */
function fakeCloud(doc: Doc) {
  let revs = 1
  const cloud = {
    doc,
    mark: undefined as CloudMark | undefined,
    puts: 0,
    /** The next PUT is accepted but its answer is lost. */
    lose: false,
    now: 10_000,
    /** The Boox saves a reading (its own clock: `updateTime`). */
    booxSaves(node: number, progress: string, updateTime: number) {
      cloud.doc = bookDoc(node, progress, updateTime, "Go7", `${++revs}-b`)
    },
    /** The Boox opens the book without reading: only `lastAccess` and `_rev` change. */
    booxOpens(lastAccess: number) {
      cloud.doc = { ...cloud.doc, lastAccess, _rev: `${++revs}-o` }
    },
  }
  const io: DocIo = {
    getDoc: async () => structuredClone(cloud.doc),
    putDoc: async (next) => {
      if (next._rev !== cloud.doc._rev) throw CONFLICT
      cloud.doc = { ...next, _rev: `${++revs}-p` }
      cloud.puts++
      if (cloud.lose) {
        cloud.lose = false
        throw new Error("socket hang up")
      }
    },
    isConflict: (error) => error === CONFLICT,
    mark: () => cloud.mark,
    setMark: (change) => void (cloud.mark = change(cloud.mark)),
    backup: () => {},
    toLocal: (p) => ({ spine: p.chapterIndex, offset: p.nodePosition, exact: true }),
    toNeo: (l) => ({ chapterIndex: l.spine, nodePosition: l.offset, textOffset: 0, xpath: [1, l.offset] }),
    now: () => cloud.now,
  }
  /** What the TUI does after applying a pulled position (the `agree` RPC). */
  const agree = (print: string, gen: number) => io.setMark((m) => withBase(m, { cloud: print, local: gen }))
  const push = (local: LocalReading, node: number, percent = 30, finished = false) => pushDoc(io, { ...local, position: { spine: 1, offset: node }, percent, finished })
  return { cloud, io, agree, push, pull: (local: LocalReading) => pullDoc(io, local) }
}

/** The cloud opened here once, from a fresh install: pulled, applied as generation 1. */
async function adopted(doc: Doc) {
  const f = fakeCloud(doc)
  const first = await f.pull({ gen: 0, turnedAt: 0 })
  assert.equal(first.action, "pull")
  f.agree(first.print, 1)
  return f
}

test("reconcile: one side changed wins whatever the clocks; both is a conflict the latest wins", () => {
  const base = { cloud: "A", local: 3 }
  const run = (cloud: string, gen: number, turnedAt: number, cloudTime: number, extra: Partial<Parameters<typeof reconcile>[0]> = {}) =>
    reconcile({ cloud, base, gen, turnedAt, cloudTime, ...extra }).action
  const rows: Array<[string, ReturnType<typeof run>, ReturnType<typeof run>]> = [
    ["neither changed", run("A", 3, 100, 900), "none"],
    ["only local, Boox clock ahead", run("A", 4, 100, 900), "push"],
    ["only cloud, Boox clock behind", run("B", 3, 900, 100), "pull"],
    ["both, local later", run("B", 4, 900, 100), "push"],
    ["both, Boox later", run("B", 4, 100, 900), "pull"],
    ["both, same time: the Boox", run("B", 4, 500, 500), "pull"],
    ["an older local generation", run("A", 2, 900, 100), "none"],
  ]
  for (const [name, got, want] of rows) assert.equal(got, want, name)

  // Our own write in the cloud: its generation becomes the base, recorded.
  const writes = [{ print: "W", gen: 5 }]
  assert.deepEqual(reconcile({ cloud: "W", base, gen: 5, writes, turnedAt: 1, cloudTime: 9 }), { action: "none", base: { cloud: "W", local: 5 } })
  assert.deepEqual(reconcile({ cloud: "W", base, gen: 6, writes, turnedAt: 1, cloudTime: 9 }), { action: "push", base: { cloud: "W", local: 5 } })
  // Already the base: nothing to record.
  assert.deepEqual(reconcile({ cloud: "W", base: { cloud: "W", local: 5 }, gen: 5, writes, turnedAt: 1, cloudTime: 9 }), { action: "none" })

  // No base: a doc from another device, the clocks once; one from OpenCode never pulls.
  assert.equal(reconcile({ cloud: "B", gen: 0, turnedAt: 0, cloudTime: 100 }).action, "pull")
  assert.equal(reconcile({ cloud: "B", gen: 2, turnedAt: 200, cloudTime: 100 }).action, "push")
  assert.equal(reconcile({ cloud: "B", gen: 2, turnedAt: 50, cloudTime: 100 }).action, "pull")
  assert.deepEqual(reconcile({ cloud: "B", gen: 2, turnedAt: 50, cloudTime: 100, ownDevice: true, receipt: 40 }), { action: "push" })
  assert.deepEqual(reconcile({ cloud: "B", gen: 2, turnedAt: 50, cloudTime: 10, ownDevice: true, receipt: 50 }), { action: "none", base: { cloud: "B", local: 2 } })
  assert.deepEqual(reconcile({ cloud: "B", gen: 0, turnedAt: 0, cloudTime: 10, ownDevice: true }), { action: "none", base: { cloud: "B", local: 0 } })
})

test("a reading print ignores _rev, lastAccess and the save time, not the position or progress", () => {
  const doc = bookDoc(120, "20/100", 5)
  const print = readingPrint(doc)
  assert.equal(readingPrint({ ...doc, _rev: "9-z", lastAccess: 99, updatedAt: 99 }), print)
  assert.equal(readingPrint(bookDoc(120, "20/100", 77, "OpenCode")), print)
  assert.equal(readingPrint(bookDoc(120, " 20 / 100 ", 5)), print)
  assert.notEqual(readingPrint(bookDoc(121, "20/100", 5)), print)
  assert.notEqual(readingPrint(bookDoc(120, "21/100", 5)), print)
})

test("the base keeps the latest local generation, and the writes the last five", () => {
  let mark = withBase(undefined, { cloud: "A", local: 6 })
  mark = withBase(mark, { cloud: "B", local: 5 })
  assert.deepEqual(mark.base, { cloud: "A", local: 6 })
  assert.deepEqual(withBase(mark, { cloud: "C", local: 6 }).base, { cloud: "C", local: 6 })
  for (let i = 0; i < 10; i++) mark = withWrite(mark, { print: `w${i}`, gen: i })
  assert.deepEqual(mark.writes!.map((w) => w.gen), [5, 6, 7, 8, 9])
})

test("1. the Boox opening the book (lastAccess and _rev only) leaves the local reading to push", async () => {
  const f = await adopted(bookDoc(100, "20/100", 2_000))
  f.cloud.booxOpens(9_000)
  const local = { gen: 2, turnedAt: 5_000 }
  assert.equal((await f.pull(local)).action, "push")
  assert.deepEqual(await f.push(local, 300), { pushed: true, at: 10_000, progress: "30/100" })
  assert.equal(f.cloud.puts, 1)
})

test("2. a due push replayed after the Boox read further, nothing turned here: pulled, Boox clock behind", async () => {
  const f = await adopted(bookDoc(100, "20/100", 2_000))
  const mine = { gen: 2, turnedAt: 5_000 }
  await f.push(mine, 300)
  f.cloud.booxSaves(500, "50/100", 1_000) // Its clock far behind ours.
  assert.deepEqual(await f.push(mine, 300), { pushed: false, reason: "the Boox is newer", pull: true })
  assert.equal(f.cloud.puts, 1)
  const pulled = await f.pull(mine)
  assert.deepEqual([pulled.action, pulled.spine, pulled.offset], ["pull", 1, 500])
})

test("3. onyx-sync.json lost, the cloud holds our old write, a page turned since: no pull back, pushed", async () => {
  const f = fakeCloud(bookDoc(200, "20/100", 4_000, "OpenCode"))
  // The old TUI's receipt: the reading of 3000 was sent; a page turned at 3500 (the server's stamp is later).
  const local = { gen: 1, turnedAt: 3_500, receipt: 3_000 }
  assert.equal((await f.pull(local)).action, "push")
  assert.equal(f.cloud.mark, undefined)
  assert.equal((await f.push(local, 300)).pushed, true)
  assert.deepEqual(f.io.mark()?.base, { cloud: readingPrint(f.cloud.doc), local: 1 })
  // No turn since the receipt: ambiguous, the local position stays and both sides agree from now on.
  const g = fakeCloud(bookDoc(200, "20/100", 4_000, "OpenCode"))
  assert.equal((await g.pull({ gen: 0, turnedAt: 3_000, receipt: 3_000 })).action, "none")
  assert.deepEqual(g.cloud.mark?.base, { cloud: readingPrint(g.cloud.doc), local: 0 })
  g.cloud.booxSaves(600, "60/100", 1) // Then the Boox reads on: pulled, whatever its clock.
  assert.equal((await g.pull({ gen: 0, turnedAt: 3_000, receipt: 3_000 })).action, "pull")
})

test("4. two windows: one adopts the Boox position, the other closes with an older one: the adopted stays", async () => {
  const f = await adopted(bookDoc(100, "20/100", 2_000))
  await f.push({ gen: 5, turnedAt: 5_000 }, 300) // Both windows held generation 5.
  f.cloud.booxSaves(500, "50/100", 6_000)
  // Window A pulls, applies it as generation 6.
  const pulled = await f.pull({ gen: 5, turnedAt: 5_000 })
  assert.equal(pulled.action, "pull")
  f.agree(pulled.print, 6)
  // Window B closes on its generation-5 position: nothing sent.
  assert.deepEqual(await f.push({ gen: 5, turnedAt: 5_000 }, 300), { pushed: false, reason: "in sync" })
  assert.equal(f.cloud.puts, 1)
  assert.equal(f.cloud.doc.progress, "50/100")
  // A stale agree never lowers the base.
  f.agree("old", 5)
  assert.deepEqual(f.cloud.mark?.base, { cloud: pulled.print, local: 6 })
})

test("5. a Boox clock 5 minutes ahead, nothing changed there: the local reading wins", async () => {
  const f = await adopted(bookDoc(100, "20/100", 1_000 + 300_000))
  const local = { gen: 2, turnedAt: 2_000 }
  assert.equal((await f.pull(local)).action, "push")
  assert.equal((await f.push(local, 300)).pushed, true)
})

test("6. a real conflict: the later of the page turn and the Boox's save wins", async () => {
  const f = await adopted(bookDoc(100, "20/100", 1_000))
  f.cloud.booxSaves(500, "50/100", 3_000)
  assert.deepEqual(await f.push({ gen: 2, turnedAt: 2_000 }, 300), { pushed: false, reason: "the Boox is newer", pull: true })
  assert.equal((await f.pull({ gen: 2, turnedAt: 2_000 })).action, "pull")
  assert.equal((await f.push({ gen: 2, turnedAt: 4_000 }, 300)).pushed, true)
})

test("7. our PUT accepted, its answer lost, a page turned meanwhile: known as ours, pushed again, not pulled", async () => {
  const f = await adopted(bookDoc(100, "20/100", 1_000))
  f.cloud.lose = true
  await assert.rejects(f.push({ gen: 2, turnedAt: 2_000 }, 300), /socket hang up/)
  assert.equal(f.cloud.puts, 1)
  f.cloud.now = 50_000 // The server's stamp is later than the next page turn here.
  const local = { gen: 3, turnedAt: 3_000 }
  assert.equal((await f.pull(local)).action, "push")
  assert.deepEqual(f.cloud.mark?.base, { cloud: readingPrint(f.cloud.doc), local: 2 })
  assert.equal((await f.push(local, 320)).pushed, true)
  assert.equal(f.cloud.puts, 2)
  // Without the turn: nothing to do.
  assert.equal((await f.pull(local)).action, "none")
})

test("8. a book is finished (total/total) only by the push of a forward turn onto the last screen", async () => {
  const f = await adopted(bookDoc(100, "20/100", 1_000))
  // On the last screen, not finished (opened there, or back then forward without the finishing turn).
  assert.deepEqual(await f.push({ gen: 2, turnedAt: 2_000 }, 9_000, 100, false), { pushed: true, at: 10_000, progress: "99/100" })
  // The forward turn onto it: same position, finished: still written.
  assert.deepEqual(await f.push({ gen: 3, turnedAt: 3_000 }, 9_000, 100, true), { pushed: true, at: 10_000, progress: "100/100" })
  // Unchanged since: nothing.
  assert.deepEqual(await f.push({ gen: 3, turnedAt: 3_000 }, 9_000, 100, true), { pushed: false, reason: "in sync" })
  // Same position and progress as the cloud's, from another generation: agreed, not written.
  assert.deepEqual(await f.push({ gen: 4, turnedAt: 4_000 }, 9_000, 100, true), { pushed: false, reason: "same position" })
  assert.equal(f.cloud.puts, 2)
  assert.equal(f.cloud.mark?.base?.local, 4)
})
