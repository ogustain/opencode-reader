import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chapterNodes, formatNeoPosition, mapChapter, MAX_DEPTH, MAX_NODES, neoPoint, neoToOffset, offsetToNeo, parseNeoPosition, withNeoFields,
} from "./neoposition.ts"

const sample =
  '{"chapterIndex":0000000007,"nodePosition":0000000826,"textOffset":0000000924,"chapterStartPosition":0000035268,"chapterEndPosition":0000039293,"chapterID":"id2.7","xpath":[0,1,5,0,0]}'
const annotation =
  '{"chapterIndex":0000000003,"nodePosition":0000001101,"textEndOffset":0000000097,"chapterStartPosition":0000002263,"chapterEndPosition":0000011939,"textStartOffset":0000000013,"chapterID":"c3","xpath":null}'

test("position strings parse tolerantly and serialize back byte for byte", () => {
  for (const text of [sample, annotation, '{"chapterIndex":0000000000,"nodePosition":0000000000,"textOffset":0000000000,"chapterStartPosition":0000000000,"chapterEndPosition":0000002339,"chapterID":"x","xpath":[]}']) {
    const parsed = parseNeoPosition(text)
    assert.ok(parsed)
    assert.equal(formatNeoPosition(parsed), text)
  }
  assert.deepEqual(neoPoint(parseNeoPosition(sample)), {
    chapterIndex: 7, nodePosition: 826, textOffset: 924, chapterStartPosition: 35268, chapterEndPosition: 39293, chapterID: "id2.7", xpath: [0, 1, 5, 0, 0],
  })
  assert.equal(neoPoint(parseNeoPosition(annotation))?.textOffset, 13)
  assert.deepEqual(neoPoint(parseNeoPosition(annotation))?.xpath, [])
  // Digits inside strings are kept as they are.
  assert.equal(formatNeoPosition(parseNeoPosition('{"chapterID":"a:007","chapterIndex":0000000001}')!), '{"chapterID":"a:007","chapterIndex":0000000001}')
  assert.equal(parseNeoPosition("not a position"), undefined)
  assert.equal(parseNeoPosition('{"pageReferenceId":"pdf-12-0"}')?.length, 1)
  assert.equal(neoPoint(parseNeoPosition('{"pageReferenceId":"pdf-12-0"}')), undefined)
})

test("fields are replaced in place and missing ones appended in NeoReader's order", () => {
  const updated = withNeoFields(parseNeoPosition(sample), { textOffset: 5, xpath: [0, 1, 2], nodePosition: 40 })
  assert.equal(
    formatNeoPosition(updated),
    '{"chapterIndex":0000000007,"nodePosition":0000000040,"textOffset":0000000005,"chapterStartPosition":0000035268,"chapterEndPosition":0000039293,"chapterID":"id2.7","xpath":[0,1,2]}',
  )
  const fresh = withNeoFields(undefined, { xpath: [1], chapterID: "c", chapterIndex: 2, nodePosition: 3, textOffset: 4, chapterStartPosition: 5, chapterEndPosition: 6 })
  assert.equal(
    formatNeoPosition(fresh),
    '{"chapterIndex":0000000002,"nodePosition":0000000003,"textOffset":0000000004,"chapterStartPosition":0000000005,"chapterEndPosition":0000000006,"chapterID":"c","xpath":[1]}',
  )
})

// A synthetic chapter: XML declaration, doctype, whitespace, head, entities, a decomposed accent, inline markup.
const chapter = [
  "<?xml version='1.0' encoding='utf-8'?>\n",
  "<!DOCTYPE html>\n",
  '<html xmlns="http://www.w3.org/1999/xhtml">\n',
  "  <head><title>Ignored title</title><style>p { margin: 0 }</style></head>\n",
  '  <body><div class="c"><h1>Chapter One</h1>\n',
  '<p class="first"><span class="pn"></span>The night was calm and the e\u0301toiles shone.</p>\n',
  "<p>Second &amp; last paragraph,\nwrapped in the source, with <i>italics</i> inside.</p>\n",
  "<!-- a comment -->\n",
  "<p>Tail&#160;end.</p></div></body>\n</html>\n",
].join("")

test("node paths count whitespace text, the doctype and comments, not the XML declaration", () => {
  const nodes = chapterNodes(chapter)
  const text = (needle: string) => nodes.find((n) => n.text?.includes(needle))!
  // "\n"(0) doctype(1) "\n"(2) html(3) → "\n  "(0) head(1) "\n  "(2) body(3) → div(0) → h1(0) "\n"(1) p(2) → span(0) text(1)
  assert.deepEqual(text("The night").path, [3, 3, 0, 2, 1])
  assert.equal(chapter.slice(text("The night").at).startsWith("The night"), true)
  assert.deepEqual(text("italics").path, [3, 3, 0, 4, 1, 0])
  assert.deepEqual(text("Tail").path, [3, 3, 0, 8, 0])
  assert.equal(text("Second").text, "Second & last paragraph,\nwrapped in the source, with ")
  // Head and style text is not visible text.
  assert.equal(nodes.some((n) => n.text?.includes("Ignored") || n.text?.includes("margin")), false)
})

test("NeoReader points map to the plugin's offsets and back, to the character", () => {
  const map = mapChapter(chapter)
  const flat = map.paragraphs.map((p) => p.text).join("\n")
  assert.deepEqual(map.paragraphs.map((p) => p.text), [
    "Chapter One",
    "The night was calm and the \u00e9toiles shone.",
    "Second & last paragraph, wrapped in the source, with italics inside.",
    "Tail\u00a0end.",
  ])
  const node = chapterNodes(chapter).find((n) => n.text?.startsWith("Second"))!
  // "last" is at offset 9 in the decoded node text (after "&amp;" became "&").
  const point = { xpath: node.path, nodePosition: node.at, textOffset: node.text!.indexOf("last") }
  const { offset, exact } = neoToOffset(map, point)
  assert.ok(exact)
  assert.ok(flat.slice(offset).startsWith("last paragraph"))
  assert.deepEqual(offsetToNeo(map, offset), point)
  // After the decomposed accent, offsets stay aligned.
  const night = chapterNodes(chapter).find((n) => n.text?.startsWith("The night"))!
  const shone = neoToOffset(map, { xpath: night.path, nodePosition: night.at, textOffset: night.text!.indexOf("shone") })
  assert.ok(flat.slice(shone.offset).startsWith("shone"))
  // Every non-space offset survives a round trip.
  for (let o = 0; o < flat.length; o++) {
    if (/\s/.test(flat[o])) continue
    assert.equal(neoToOffset(map, offsetToNeo(map, o)).offset, o, `offset ${o}`)
  }
})

test("an element, a stale xpath, the chapter start and unknown nodes all resolve", () => {
  const map = mapChapter(chapter)
  const flat = map.paragraphs.map((p) => p.text).join("\n")
  const nodes = chapterNodes(chapter)
  // An element points at its first text.
  const p = nodes.find((n) => n.text === undefined && chapter.startsWith("<p>Tail", n.at))!
  assert.ok(flat.slice(neoToOffset(map, { xpath: p.path, nodePosition: p.at, textOffset: 0 }).offset).startsWith("Tail"))
  // A wrong xpath falls back to nodePosition.
  const tail = nodes.find((n) => n.text?.startsWith("Tail"))!
  assert.ok(flat.slice(neoToOffset(map, { xpath: [9, 9], nodePosition: tail.at, textOffset: 5 }).offset).startsWith("end."))
  // Empty xpath with zeros: chapter start.
  assert.deepEqual(neoToOffset(map, { xpath: [], nodePosition: 0, textOffset: 0 }), { offset: 0, exact: true })
  // Nothing matches: proportional, flagged inexact.
  const guess = neoToOffset(map, { xpath: [7], nodePosition: Math.floor(chapter.length / 2), textOffset: 0 })
  assert.equal(guess.exact, false)
  assert.ok(guess.offset > 0 && guess.offset < map.chars)
  // A chapter without text: the chapter start.
  assert.deepEqual(offsetToNeo(mapChapter("<html><body><img src='a.png'/></body></html>"), 0), { xpath: [], nodePosition: 0, textOffset: 0 })
})

test("decomposed Hangul and stacked marks align to the character", () => {
  const word = "가나다".normalize("NFD") // Six jamo, three syllables once composed.
  const stacked = "e\u0323\u0301" // NFC: ẹ + a combining acute (two units).
  const chapter = `<html><body><p>${word} words ${stacked}nd follow.</p></body></html>`
  const map = mapChapter(chapter)
  const flat = map.paragraphs[0].text
  assert.equal(flat, `가나다 words ${stacked.normalize("NFC")}nd follow.`)
  const source = map.nodes.find((n) => n.text)!.text!
  for (const [target, inSource] of [["words", "words"], ["nd", "nd"], ["나", word.slice(2)]]) {
    const at = offsetToNeo(map, flat.indexOf(target))
    assert.equal(at.textOffset, source.indexOf(inSource), target)
    assert.deepEqual(neoToOffset(map, at), { offset: flat.indexOf(target), exact: true })
  }
})

test("alignment always terminates, and falls back to proportional offsets past its step budget", () => {
  // Deterministic pseudo-random mixes of the characters that make alignment hard.
  let seed = 7
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n)
  const pool = [
    "a", "Z", " ", "\n", "\u00a0", "\u00ad", "\u200b", "\u200d", "\ufeff", "\u0301", "\u0323", "\u0308", "e\u0301", "é",
    "\u1100", "\u1161", "\u11a8", "가", "\u212b", "\uf900", "字", "😀", "👍🏽", "&amp;", "&#x301;", "&nbsp;", "<i>", "</i>", "<br/>",
    "<span>", "</span>", "<!-- c -->", "\u0915\u094d\u0937", "\u0e01\u0e33",
  ]
  for (let round = 0; round < 400; round++) {
    let body = ""
    for (let i = random(60); i >= 0; i--) body += pool[random(pool.length)]
    const chapter = `<html><body><p>${body}</p><p>${body.split("").reverse().join("")}</p></body></html>`
    const map = mapChapter(chapter)
    assert.ok(map.count <= map.chars)
    for (let i = 1; i < map.count; i++) assert.ok(map.offset[i] > map.offset[i - 1], `round ${round}`)
    for (let offset = 0; offset < map.chars; offset += 7) neoToOffset(map, offsetToNeo(map, offset))
  }
  const capped = mapChapter("<html><body><p>Some words here.</p></body></html>", { maxSteps: 3 })
  assert.equal(capped.count, 0)
  assert.equal(neoToOffset(capped, { xpath: [0, 0, 0, 0], nodePosition: 15, textOffset: 2 }).exact, false)
})

test("a hostile chapter is refused before its node paths are built", () => {
  const nested = (depth: number) => `<html><body>${"<div>".repeat(depth)}x${"</div>".repeat(depth)}</body></html>`
  assert.ok(chapterNodes(nested(MAX_DEPTH - 3)).length > 0)
  const started = Date.now()
  assert.throws(() => chapterNodes(nested(2000)), /too deeply nested/) // 6 KB that once made 2M path entries.
  assert.throws(() => mapChapter(nested(2000)), /too deeply nested/)
  assert.throws(() => chapterNodes(`<html><body>${"<br/>".repeat(MAX_NODES + 1)}</body></html>`), /too many elements/)
  assert.ok(Date.now() - started < 2000)
})

test("a chapter source over 16 MiB is not aligned", () => {
  assert.throws(() => mapChapter(`<html><body><p>${"a".repeat(16 * 1024 * 1024)}</p></body></html>`), /too large/)
})
