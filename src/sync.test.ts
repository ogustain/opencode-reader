import { test } from "node:test"
import assert from "node:assert/strict"
import { mapChapter } from "./neoposition.ts"
import {
  cloudLibrary, cloudReading, cloudSide, decidePull, decidePush, downloadBatch, libraryTree, patchBookDoc, progressFor, pushQueue, setBackendFields, toLocal, toNeo, withPushedProgress, withWrite,
  type NeoRef,
} from "./sync.ts"

const book = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: `u1#${id}`, _rev: "3-x", modeType: 4, uniqueId: id, status: 0, type: "epub", name: `${id}.epub`, title: null,
  nativeAbsolutePath: `/storage/emulated/0/Books/${id}.epub`, size: 1000, progress: "10/100", lastAccess: 0, ...extra,
})
const collection = (id: string, name: string, parent?: string) => ({ _id: `u1#${id}`, modeType: 3, uniqueId: id, name, status: 0, ...(parent ? { parentUniqueId: parent } : {}) })
const member = (bookId: string, collectionId: string, status = 0) => ({ _id: `u1#m-${bookId}-${collectionId}-${status}`, modeType: 5, documentUniqueId: bookId, libraryUniqueId: collectionId, status })

test("the library tree nests collections, hides finished books and skips removed docs", () => {
  const docs = [
    collection("lit", "Literature"),
    collection("classic", "Classics", "lit"),
    collection("empty", "Empty"),
    collection("orphan", "Orphan", "gone"),
    book("a", { title: "Alpha", lastAccess: 5 }),
    book("b", { title: "Beta", progress: "100/100" }),
    book("c", { lastAccess: 9 }),
    book("d", { title: "Delta", fileSyncStatus: 1 }),
    book("p", { type: "pdf", nativeAbsolutePath: "/x/p.pdf" }),
    book("r", { status: 1 }),
    { _id: "u1#note", modeType: 1, documentId: "a", quote: "q" },
    member("a", "classic"),
    member("b", "classic"),
    member("c", "lit"),
    member("d", "classic", 1),
    member("p", "lit"),
    member("c", "orphan"),
  ]
  const library = cloudLibrary(docs)
  assert.deepEqual(library.books.map((b) => b.title).sort(), ["Alpha", "Beta", "Delta", "c"])
  assert.equal(library.books.find((b) => b.title === "Alpha")?.percent, 10)
  assert.deepEqual(library.books.filter((b) => b.uploaded).map((b) => b.title), ["Delta"])

  const { root, finished } = libraryTree(library)
  assert.equal(finished, 1)
  assert.deepEqual(root.children.map((c) => [c.name, c.count]), [["Literature", 2], ["Orphan", 1]])
  const lit = root.children[0]
  assert.deepEqual(lit.books.map((b) => b.title), ["c"])
  assert.deepEqual(lit.children.map((c) => [c.name, c.books.map((b) => b.title)]), [["Classics", ["Alpha"]]])
  // Removed membership: Delta is in no collection.
  assert.deepEqual(root.books.map((b) => b.title), ["Delta"])
  assert.equal(root.count, 4)

  const all = libraryTree(library, { showFinished: true }).root
  assert.deepEqual(all.children[0].children[0].books.map((b) => b.title), ["Alpha", "Beta"])
})

const position = (fields: string) =>
  `{"chapterIndex":0000000002,"nodePosition":0000000120,"textOffset":0000000004,"chapterStartPosition":0000001000,"chapterEndPosition":0000002000,${fields}"xpath":[1,3,0,1,0]}`
const extra = (backend: string) => `{"backend":{"zip_pass":"","viewport":"{\\"bottom\\":1633.0}",${backend}"total_page":129},"dummyObject":{"a":1.0}}`
const v2 = position(`"chapterID":"c2",`)

test("the reading position comes from v3, v2 or current_page", () => {
  const doc = book("a", {
    lastAccess: 7,
    extraAttributes: extra(`"current_page_position_v2":${JSON.stringify(v2)},"user_doc_data_update_time":5,"device_model":"Go7",`),
  })
  assert.deepEqual(cloudReading(doc), {
    point: { chapterIndex: 2, nodePosition: 120, textOffset: 4, chapterStartPosition: 1000, chapterEndPosition: 2000, chapterID: "c2", xpath: [1, 3, 0, 1, 0] },
    updateTime: 5, lastAccess: 7, deviceModel: "Go7", totalPage: 129,
  })
  assert.deepEqual(cloudReading(book("b")), { updateTime: 0, lastAccess: 0 })
})

test("a patch changes only the position fields, progress and dates, byte for byte elsewhere", () => {
  const original = extra(
    `"current_page_position_v2":${JSON.stringify(v2)},"current_page_position_v3":${JSON.stringify(v2)},"user_doc_data_update_time":5,"device_id":"d","device_model":"Go7",`,
  )
  const doc = { ...book("a", { extraAttributes: original, updatedAt: 1, createdAt: 0 }), _cv: "cv" }
  const fields = { chapterIndex: 3, nodePosition: 40, textOffset: 2, chapterStartPosition: 2000, chapterEndPosition: 2600, chapterID: "c3", xpath: [1, 3, 2, 0] }
  const patched = patchBookDoc(doc, { fields, percent: 23.4, finished: false, now: 99 })!
  assert.ok(patched)
  // Top level: only progress, updatedAt and extraAttributes differ; _cv is gone.
  const changed = Object.keys({ ...doc, ...patched }).filter((k) => JSON.stringify((doc as Record<string, unknown>)[k]) !== JSON.stringify(patched[k]))
  assert.deepEqual(changed.sort(), ["_cv", "extraAttributes", "progress", "updatedAt"])
  assert.equal("_cv" in patched, false)
  assert.equal(patched.progress, "30/129")
  assert.equal(patched.updatedAt, 99)
  assert.equal(patched._rev, "3-x")
  const written = `{"chapterIndex":0000000003,"nodePosition":0000000040,"textOffset":0000000002,"chapterStartPosition":0000002000,"chapterEndPosition":0000002600,"chapterID":"c3","xpath":[1,3,2,0]}`
  // extraAttributes: the same bytes except the patched values (current_page added at the end of backend).
  const expected = original
    .split(JSON.stringify(v2)).join(JSON.stringify(written))
    .replace('"user_doc_data_update_time":5', '"user_doc_data_update_time":99')
    .replace('"device_model":"Go7"', '"device_model":"OpenCode"')
    .replace('"total_page":129}', `"total_page":129,"current_page":${JSON.stringify(written)}}`)
  assert.equal(patched.extraAttributes, expected)
  // Floats like 1633.0 survive (a JSON round trip would write 1633).
  assert.ok(String(patched.extraAttributes).includes("1633.0") && String(patched.extraAttributes).includes('"a":1.0'))

  // Unsafe docs are left alone, and so is a doc with no usable position (none is made up).
  const unread = book("b", { extraAttributes: extra("") })
  assert.equal(cloudReading(unread).totalPage, 129)
  assert.equal(cloudReading(unread).point, undefined)
  assert.equal(patchBookDoc(unread, { fields, percent: 1, finished: false, now: 1 }), undefined)
  const unusable = book("c", { extraAttributes: extra(`"current_page_position_v3":"{}","current_page":"",`) })
  assert.equal(patchBookDoc(unusable, { fields, percent: 1, finished: false, now: 1 }), undefined)
  assert.equal(patchBookDoc({ ...doc, modeType: 1 }, { fields, percent: 1, finished: false, now: 1 }), undefined)
  assert.equal(patchBookDoc({ ...doc, _rev: undefined }, { fields, percent: 1, finished: false, now: 1 }), undefined)
  assert.equal(patchBookDoc({ ...doc, extraAttributes: "{not json" }, { fields, percent: 1, finished: false, now: 1 }), undefined)
  assert.equal(setBackendFields('{"other":{}}', { a: 1 }), undefined)
  assert.equal(setBackendFields('{"backend":{}}', { a: 1 }), '{"backend":{"a":1}}')
})

test("a push from the last screen writes total/total, the real position, and reads back as finished", () => {
  const doc = book("a", { readingStatus: 1, extraAttributes: extra(`"current_page_position_v3":${JSON.stringify(v2)},"user_doc_data_update_time":5,`) })
  // The last screen starts inside the chapter: the position says so, the progress says the end.
  const fields = { chapterIndex: 9, nodePosition: 4321, textOffset: 7, chapterStartPosition: 9000, chapterEndPosition: 9900, chapterID: "c9", xpath: [1, 3, 8, 0] }
  const patched = patchBookDoc(doc, { fields, percent: 100, finished: true, now: 99 })!
  assert.equal(patched.progress, "129/129")
  assert.equal(patched.readingStatus, 1) // Left to NeoReader.
  const reading = cloudReading(patched)
  assert.equal(reading.point?.nodePosition, 4321)
  assert.equal(reading.point?.textOffset, 7)
  assert.equal(cloudLibrary([patched]).books[0].finished, true)
})

test("progress uses the doc's page count, from page 1, and total/total only for a finished book", () => {
  assert.equal(progressFor(23.4, 129, false), "30/129")
  assert.equal(progressFor(0, 1398, false), "1/1398")
  assert.equal(progressFor(100, 54, true), "54/54")
  assert.equal(progressFor(40, 54, true), "54/54")
  // Unfinished: at most total - 1, however close to the end.
  assert.equal(progressFor(99.9, 129, false), "128/129")
  assert.equal(progressFor(100, 54, false), "53/54")
  assert.equal(progressFor(140, 54, false), "53/54")
  // A one-page book: 0/1 until finished, then 1/1.
  assert.equal(progressFor(0, 1, false), "0/1")
  assert.equal(progressFor(99.9, 1, false), "0/1")
  assert.equal(progressFor(99.9, 1, true), "1/1")
})

test("going back below 100 % unfinishes the book in the patch and the cached library", () => {
  const doc = book("a", { progress: "129/129", extraAttributes: extra(`"current_page_position_v3":${JSON.stringify(v2)},`) })
  const fields = { chapterIndex: 9, nodePosition: 4000, textOffset: 0 }
  const library = cloudLibrary([doc])
  assert.equal(library.books[0].finished, true)
  const patched = patchBookDoc(doc, { fields, percent: 99.9, finished: false, now: 99 })!
  assert.equal(patched.progress, "128/129")
  const after = withPushedProgress(library.books, library.books[0].id, patched.progress)
  assert.equal(after[0].finished, false)
  assert.equal(libraryTree({ collections: [], books: after }).root.books.length, 1)
})

test("push only a new position read here after the Boox last saved", () => {
  const local = { spine: 2, offset: 100 }
  assert.deepEqual(decidePush({ cloudTime: 5, local }), { push: false, reason: "no local reading" })
  assert.deepEqual(decidePush({ turnedAt: 5, cloudTime: 5, local }), { push: false, reason: "the Boox is newer" })
  assert.deepEqual(decidePush({ turnedAt: 6, cloudTime: 5, local, cloud: { spine: 2, offset: 100 } }), { push: false, reason: "same position" })
  assert.deepEqual(decidePush({ turnedAt: 6, cloudTime: 5, local, cloud: { spine: 2, offset: 90 } }), { push: true })
  assert.deepEqual(decidePush({ turnedAt: 6, cloudTime: 5, local }), { push: true })
})

test("the same position with a new progress or finished state is pushed, not acknowledged as sent", () => {
  const end = { spine: 9, offset: 4000 }
  const at = (local: string, cloud: unknown) => decidePush({ turnedAt: 6, cloudTime: 5, local: end, cloud: end, progress: { local, cloud } })
  // Back, then forward again onto the last screen the cloud already holds unfinished: finish it.
  assert.deepEqual(at("129/129", "128/129"), { push: true })
  // Finished in the cloud, unfinished here at the same screen: unfinish it.
  assert.deepEqual(at("128/129", "129/129"), { push: true })
  assert.deepEqual(at("127/129", "128/129"), { push: true })
  assert.deepEqual(at("128/129", undefined), { push: true })
  // Nothing new: skipped (the TUI acknowledges it).
  assert.deepEqual(at("129/129", "129/129"), { push: false, reason: "same position" })
  assert.deepEqual(at("128/129", " 128 / 129 "), { push: false, reason: "same position" })
  // A new position is pushed whatever the progress.
  assert.deepEqual(decidePush({ turnedAt: 6, cloudTime: 5, local: end, cloud: { spine: 9, offset: 0 }, progress: { local: "128/129", cloud: "128/129" } }), { push: true })
})

test("pull a newer Boox position, not our own push", () => {
  const cloud = { spine: 4, offset: 0 }
  const local = { spine: 2, offset: 100 }
  assert.equal(decidePull({ updateTime: 10, lastAccess: 10, local, cloud }), true)
  assert.equal(decidePull({ turnedAt: 20, updateTime: 10, lastAccess: 10, local, cloud }), false)
  assert.equal(decidePull({ turnedAt: 20, updateTime: 10, lastAccess: 30, local, cloud }), true) // Opened on the Boox since.
  assert.equal(decidePull({ turnedAt: 5, updateTime: 10, lastAccess: 0, local: cloud, cloud }), false)
  assert.equal(decidePull({ turnedAt: 5, updateTime: 10, lastAccess: 8, side: { kind: "ours", turnedAt: 5 }, local, cloud }), false)
  assert.equal(decidePull({ turnedAt: 5, updateTime: 10, lastAccess: 8, local }), false)
})

test("positions convert through the spine, skipping chapters the plugin does not show", () => {
  const chapter = '<?xml version="1.0"?>\n<html><body><p>First words.</p><p>Second line here.</p></body></html>'
  const map = mapChapter(chapter)
  const refs: NeoRef[] = [
    { id: "cover", spine: -1, start: 0, end: 300 },
    { id: "c1", spine: 0, start: 300, end: 300 + chapter.length },
  ]
  const offset = map.paragraphs[0].text.length + 1 + "Second ".length
  const fields = toNeo({ spine: 0, offset }, refs, map)!
  assert.deepEqual(fields, { chapterIndex: 1, nodePosition: chapter.indexOf("Second"), textOffset: 7, chapterStartPosition: 300, chapterEndPosition: 300 + chapter.length, chapterID: "c1", xpath: [1, 0, 1, 0] })
  const point = { chapterIndex: 1, nodePosition: fields.nodePosition as number, textOffset: 7, chapterID: "c1", xpath: fields.xpath as number[] }
  assert.deepEqual(toLocal(point, refs, () => map), { spine: 0, offset, exact: true })
  // The chapter id wins over a shifted index; a skipped chapter opens the next one.
  assert.deepEqual(toLocal({ ...point, chapterIndex: 0 }, refs, () => map), { spine: 0, offset, exact: true })
  assert.deepEqual(toLocal({ ...point, chapterIndex: 0, chapterID: "cover" }, refs, () => map), { spine: 0, offset: 0, exact: false })
  assert.equal(toLocal({ ...point, chapterIndex: 5, chapterID: "nope" }, refs, () => map), undefined)
  assert.equal(toNeo({ spine: 3, offset: 0 }, refs, map), undefined)
})

test("our own write is recognised by its device, update time and progress, on both sides", () => {
  const local = { spine: 2, offset: 100 }
  // We pushed the reading of t=100; the server stamped it 104 (its clock), while a page turned at 102.
  const mark = withWrite(undefined, { pushedAt: 104, turnedAt: 100, progress: "20/100" })
  const ours = cloudSide({ updateTime: 104, deviceModel: "OpenCode", progress: "20/100" }, mark)
  assert.deepEqual(ours, { kind: "ours", turnedAt: 100 })
  assert.deepEqual(decidePush({ turnedAt: 102, cloudTime: 104, side: ours, local, cloud: { spine: 2, offset: 50 } }), { push: true })
  assert.deepEqual(decidePush({ turnedAt: 100, cloudTime: 104, side: ours, local, cloud: { spine: 2, offset: 50 } }), { push: false, reason: "already sent" })
  // The Boox saved since (another device, update time or progress): its time counts.
  assert.deepEqual(cloudSide({ updateTime: 104, deviceModel: "Go7", progress: "20/100" }, mark), { kind: "changed" })
  assert.deepEqual(cloudSide({ updateTime: 105, deviceModel: "OpenCode", progress: "20/100" }, mark), { kind: "changed" })
  assert.deepEqual(cloudSide({ updateTime: 104, deviceModel: "OpenCode", progress: "30/100" }, mark), { kind: "changed" })
  assert.deepEqual(cloudSide({ updateTime: 104, deviceModel: "OpenCode" }, undefined), { kind: "changed" })
  assert.deepEqual(decidePush({ turnedAt: 102, cloudTime: 104, side: { kind: "changed" }, local }), { push: false, reason: "the Boox is newer" })

  // Reopening: our own write is not pulled back as a Boox position, even if the Boox opened the book since.
  const cloud = { spine: 2, offset: 50 }
  assert.equal(decidePull({ turnedAt: 102, updateTime: 104, lastAccess: 110, side: ours, local, cloud }), false)
  assert.equal(decidePull({ turnedAt: 102, updateTime: 104, lastAccess: 0, side: { kind: "changed" }, local, cloud }), true)
  // Another window's later write (same identity) is pulled by a window holding an older reading.
  assert.equal(decidePull({ turnedAt: 90, updateTime: 104, lastAccess: 0, side: ours, local, cloud }), true)
})

test("a PUT accepted but unanswered is still known as ours, from the write recorded before it", () => {
  const local = { spine: 2, offset: 100 }
  // Recorded before the PUT: stamped 104, carrying the turn of 100. The answer was lost.
  let mark = withWrite(undefined, { pushedAt: 90, turnedAt: 80 })
  mark = withWrite(mark, { pushedAt: 104, turnedAt: 100, progress: "20/100" })
  const side = cloudSide({ updateTime: 104, deviceModel: "OpenCode", progress: "20/100" }, mark)
  // A page turned at 102 (local clock behind the server's): pushed, not "the Boox is newer".
  assert.deepEqual(decidePush({ turnedAt: 102, cloudTime: 104, side, local, cloud: { spine: 2, offset: 50 } }), { push: true })
  // And the old cloud position never wins a pull against it.
  assert.equal(decidePull({ turnedAt: 102, updateTime: 104, lastAccess: 0, side, local, cloud: { spine: 2, offset: 50 } }), false)
  // Only the last writes are kept.
  for (let i = 0; i < 10; i++) mark = withWrite(mark, { pushedAt: 200 + i, turnedAt: 200 + i })
  assert.equal(mark.writes!.length, 5)
  assert.equal(mark.writes![0].pushedAt, 205)
})

test("pushes run one at a time per book, and the latest waiting snapshot goes next", async () => {
  const sent: Array<[string, number]> = []
  const gates: Array<() => void> = []
  const push = pushQueue<{ turnedAt: number }>(async (key, s) => {
    sent.push([key, s.turnedAt])
    await new Promise<void>((resolve) => gates.push(resolve))
  })
  const first = push("a", { turnedAt: 1 })
  void push("a", { turnedAt: 3 }) // Turned during the push.
  void push("a", { turnedAt: 2 }) // Older: ignored.
  void push("b", { turnedAt: 1 }) // Another book: not held up.
  assert.deepEqual(sent, [["a", 1], ["b", 1]])
  gates.shift()!()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sent, [["a", 1], ["b", 1], ["a", 3]])
  for (const open of gates.splice(0)) open()
  await first
  // Idle again: a new snapshot starts at once.
  void push("a", { turnedAt: 4 })
  assert.deepEqual(sent.at(-1), ["a", 4])
  for (const open of gates.splice(0)) open()
})

test("a batch download stops asking the cloud after a token refusal, and says it once", async () => {
  const asked: Array<[string, boolean]> = []
  const result = await downloadBatch(["a", "b", "c", "d", "e"], async (book, cloud) => {
    asked.push([book, cloud])
    if (book === "a") return { ok: true }
    if (book === "b") return { ok: false, expired: true } // Cloud refused, no Boox plugged in.
    if (book === "c") return { ok: true } // Copied over ADB.
    if (book === "d") return { ok: false, notHere: true }
    return { ok: false }
  })
  assert.deepEqual(asked, [["a", true], ["b", true], ["c", false], ["d", false], ["e", false]])
  assert.deepEqual(result, { downloaded: 2, onBoox: 2, failed: ["e"], expired: true })
  const fine = await downloadBatch(["a"], async () => ({ ok: true }))
  assert.equal(fine.expired, false)
})

test("a push finishing a book hides it from the cached library at once", () => {
  const library = cloudLibrary([book("a", { progress: "128/129" }), book("b", { progress: "3/10" })])
  assert.equal(library.books[0].finished, false)
  const after = withPushedProgress(library.books, library.books[0].id, "129/129")
  assert.deepEqual([after[0].finished, after[0].current, after[0].total, after[0].percent], [true, 129, 129, 100])
  assert.deepEqual(after[1], library.books[1])
  assert.equal(libraryTree({ collections: [], books: after }).root.books.length, 1)
  // A push short of the end updates the %, and an unreadable progress leaves the cache as it was.
  assert.equal(withPushedProgress(library.books, library.books[1].id, "5/10")[1].percent, 50)
  assert.deepEqual(withPushedProgress(library.books, library.books[0].id, undefined), library.books)
})
