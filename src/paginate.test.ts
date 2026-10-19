import { test } from "node:test"
import assert from "node:assert/strict"
import {
  atBookEnd, booxHint, chooseStart, column, contents, fromPercent, isFinished, justify, keepsStored, lastScreen, layout, lineAt, nextChapter, nextScreen, previousScreen,
  progressOf, savedFinish, savedTimes, screenAt, toPercent, turnForward,
} from "./paginate.ts"
import { chapterLength, type Paragraph } from "./text.ts"
import type { Display, Line } from "./paginate.ts"

const paragraphs: Paragraph[] = [
  { text: "Title", heading: true },
  { text: "The quick brown fox jumps over the lazy dog again and again." },
  { text: "Line one\nLine two" },
  { text: "Supercalifragilisticexpialidocious" },
]

test("wraps on spaces, hard-splits long words, keeps offsets", () => {
  const lines = layout(paragraphs, 20)
  assert.deepEqual(
    lines.map((l) => l.text),
    ["Title", "", "The quick brown fox", "jumps over the lazy", "dog again and again.", "", "Line one", "Line two", "", "Supercalifragilistic", "expialidocious"],
  )
  assert.equal(lines[0].heading, true)
  const flat = paragraphs.map((p) => p.text).join("\n")
  for (const line of lines) if (line.text) assert.equal(flat.slice(line.start, line.start + line.text.length), line.text)
  for (const line of lines) assert.ok(line.text.length <= 20)
})

const long: Paragraph[] = Array.from({ length: 40 }, (_, i) => ({ text: `Paragraph ${i} ` + "lorem ipsum dolor sit amet ".repeat(5) }))

/** Offset of the first character on screen: the top line's start, or the offset itself when it is inside that line. */
const holds = (line: { text: string; start: number }, offset: number) => line.start <= offset && offset <= line.start + Math.max(1, line.text.length)

test("the screen starts at the line holding the position, whatever the size", () => {
  const total = chapterLength(long)
  for (const offset of [0, 137, 1500, total - 2]) {
    for (const [width, height] of [[30, 10], [60, 20], [100, 5]]) {
      const screen = screenAt(layout(long, width), height, offset)
      assert.ok(screen.lines.length > 0 && screen.lines.length <= height)
      assert.ok(holds(screen.lines[0], offset), `${offset} at ${width}x${height}`)
    }
  }
})

test("a one-line height change or a re-wrap keeps the first displayed text on the top line", () => {
  for (const [width, height] of [[40, 12], [60, 7]]) {
    const lines = layout(long, width)
    // Walk every screen as the reader would, then resize at each one.
    for (let offset: number | undefined = 0; offset !== undefined; offset = nextScreen(lines, height, offset)) {
      const top = screenAt(lines, height, offset).lines[0]
      for (const h of [height - 1, height + 1]) assert.deepEqual(screenAt(lines, h, offset).lines[0], top)
      for (const w of [width - 3, width + 5]) assert.ok(holds(screenAt(layout(long, w), height, offset).lines[0], top.start))
    }
  }
})

test("turning pages walks the whole chapter, both ways", () => {
  const lines = layout(paragraphs, 12)
  const height = 3
  const seen: number[] = []
  let offset: number | undefined = 0
  for (; offset !== undefined; offset = nextScreen(lines, height, offset)) {
    const screen = screenAt(lines, height, offset)
    assert.equal(screen.page, seen.length)
    seen.push(screen.first)
  }
  // Screens of `height` lines from the top, the last one ending the chapter.
  assert.deepEqual(seen, seen.map((_, i) => i * height))
  assert.ok(seen.at(-1)! + height >= lines.length)
  assert.equal(screenAt(lines, height, lines[seen.at(-1)!].start).pages, seen.length)
  // Backwards from the last full screen: at most `height` lines per step, down to the first line.
  const back: number[] = []
  for (offset = lastScreen(lines, height); offset !== undefined; offset = previousScreen(lines, height, offset)) back.push(lineAt(lines, offset))
  assert.equal(back[0], lines.length - height)
  for (let i = 1; i < back.length; i++) assert.ok(back[i] < back[i - 1] && back[i - 1] - back[i] <= height)
  assert.equal(back.at(-1), 0)
  assert.equal(lineAt(lines, 0), 0)
  assert.deepEqual(screenAt([], 10, 0), { first: 0, lines: [], page: 0, pages: 1 })
  assert.equal(nextScreen([], 10, 0), undefined)
  assert.equal(previousScreen([], 10, 0), undefined)
})

const noChapter = async () => undefined

test("a forward turn onto the book's last screen finishes it, and turning back unfinishes it", async () => {
  const lines = layout(paragraphs, 12)
  const height = 3
  const length = chapterLength(paragraphs)
  const chapters = [500, length, 0] // The last chapter has no text.
  const turns: Array<{ to: { spine: number; offset: number }; finished: boolean }> = []
  for (let from = { spine: 1, offset: 0 }; ; ) {
    const turn = await turnForward(chapters, from, lines, height, noChapter)
    if (turn.end) break
    turns.push(turn)
    from = turn.to
  }
  assert.ok(turns.length > 1)
  assert.deepEqual(turns.map((t) => t.finished), turns.map((_, i) => i === turns.length - 1))
  const end = turns.at(-1)!.to
  assert.ok(toPercent(chapters, end) < 100) // The position is the start of the screen.
  assert.equal(progressOf(chapters, end, true), 100)
  const back = previousScreen(lines, height, end.offset)!
  assert.ok(progressOf(chapters, { spine: 1, offset: back }, false) <= 99)
  // Onto a next chapter that fits on one screen: finished on landing.
  const short = layout([{ text: "The end." }], 12)
  const across = await turnForward([length, 8], { spine: 0, offset: end.offset }, lines, height, async () => short)
  assert.deepEqual(across, { to: { spine: 1, offset: 0 }, end: false, finished: true })
  // The same screen in an earlier chapter is not the end.
  assert.equal(atBookEnd([length, 500], 0, lines, height, end.offset), false)
})

test("opening, resizing or restoring never finish a book", async () => {
  const lines = layout(paragraphs, 12)
  const length = chapterLength(paragraphs)
  const chapters = [length]
  const end = { spine: 0, offset: lastScreen(lines, 3) }
  // Opened at the end: shown below 100 %, unless a page turn finished it there before.
  assert.equal(savedFinish(undefined, end), false)
  assert.equal(savedFinish({ ...end, finished: false }, end), false)
  assert.equal(savedFinish({ ...end }, end), false)
  assert.equal(savedFinish({ ...end, finished: true }, { spine: 0, offset: 0 }), false)
  assert.equal(savedFinish({ ...end, finished: true }, end), true)
  assert.ok(progressOf(chapters, end, false) <= 99)
  assert.equal(progressOf([10], { spine: 0, offset: 10 }, false), 99) // Even at the very end of the text.
  // Resized: a taller screen makes the first one the last, still shown below 100 %;
  // pressing on from there finishes the book.
  assert.equal(atBookEnd(chapters, 0, lines, lines.length, 0), true)
  assert.equal(progressOf(chapters, { spine: 0, offset: 0 }, false), 0)
  assert.deepEqual(await turnForward(chapters, { spine: 0, offset: 0 }, lines, lines.length, noChapter), { to: { spine: 0, offset: 0 }, end: true, finished: true })
  // A single-screen book: 0 % when opened, finished by a forward turn.
  const one = layout([{ text: "Short." }], 12)
  assert.equal(progressOf([7], { spine: 0, offset: 0 }, false), 0)
  assert.deepEqual(await turnForward([7], { spine: 0, offset: 0 }, one, 3, noChapter), { to: { spine: 0, offset: 0 }, end: true, finished: true })
  // An empty book: 0 %, and never finished.
  assert.equal(progressOf([0, 0], { spine: 0, offset: 0 }, false), 0)
  assert.equal(atBookEnd([0, 0], 0, [], 3, 0), false)
  assert.deepEqual(await turnForward([0, 0], { spine: 0, offset: 0 }, [], 3, noChapter), { to: { spine: 0, offset: 0 }, end: true, finished: false })
})

test("position and percentage round trip", () => {
  const chapters = [0, 1000, 0, 3000, 1000]
  for (const percent of [0, 3.3, 20, 20.01, 50, 79.99, 99.9]) {
    const position = fromPercent(chapters, percent)
    assert.ok(chapters[position.spine] > 0)
    assert.ok(Math.abs(toPercent(chapters, position) - percent) < 0.05, `${percent}`)
  }
  assert.deepEqual(fromPercent(chapters, 0), { spine: 1, offset: 0 })
  assert.deepEqual(fromPercent(chapters, 100), { spine: 4, offset: 1000 })
  assert.equal(toPercent(chapters, { spine: 3, offset: 0 }), 20)
  assert.equal(toPercent(chapters, { spine: 3, offset: 99_999 }), 80)
  assert.deepEqual(fromPercent([0, 0], 50), { spine: 0, offset: 0 })
  assert.equal(toPercent([], { spine: 0, offset: 0 }), 0)
})

test("chapter navigation skips empty chapters", () => {
  const chapters = [0, 10, 0, 5]
  assert.equal(nextChapter(chapters, 1, 1), 3)
  assert.equal(nextChapter(chapters, 3, -1), 1)
  assert.equal(nextChapter(chapters, 1, -1), undefined)
  assert.equal(nextChapter(chapters, 3, 1), undefined)
})

const modes: Array<Partial<Display>> = [
  {},
  { paragraphs: "indent" },
  { lines: "airy" },
  { align: "justify" },
  { paragraphs: "indent", lines: "airy", align: "justify" },
]
const story: Paragraph[] = [
  { text: "A heading that is long enough to wrap", heading: true },
  ...long.slice(0, 6),
  { text: "Short line\nwith a hard break and then quite a lot more words after it" },
]

test("every display mode keeps offsets, widths and the source text", () => {
  const flat = story.map((p) => p.text).join("\n")
  for (const mode of modes) {
    const lines = layout(story, 30, mode)
    for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].start, `starts sorted in ${JSON.stringify(mode)}`)
    for (const line of lines) {
      assert.ok(line.text.length <= 30, `"${line.text}" too wide`)
      const words = line.text.trim().replace(/ +/g, " ")
      if (words) assert.equal(flat.slice(line.start, line.start + words.length), words)
    }
  }
})

test("paragraph spacing, line spacing and alignment", () => {
  const text = (mode: Partial<Display>) => layout(story, 30, mode).map((l) => l.text)
  // Blank (default): one blank line between paragraphs.
  assert.equal(text({})[2], "")
  // Indent: no blank line except around headings, 2-space first lines.
  const indented = layout(story, 30, { paragraphs: "indent" })
  assert.equal(indented.filter((l) => l.text === "").length, 1)
  assert.ok(indented.filter((l) => l.text.startsWith("  ")).length === story.length - 1)
  assert.ok(!indented[0].text.startsWith(" "))
  // Airy: never two lines of text in a row; spacers are never a screen's first line.
  const airy = layout(story, 30, { lines: "airy" })
  for (let i = 1; i < airy.length; i++) assert.ok(airy[i].text === "" || airy[i - 1].text === "")
  for (let offset: number | undefined = 0; offset !== undefined; offset = nextScreen(airy, 7, offset)) {
    // A spacer is blank and shares the next line's start.
    const { first } = screenAt(airy, 7, offset)
    assert.ok(!(airy[first].text === "" && airy[first + 1]?.start === airy[first].start), `spacer on top at line ${first}`)
  }
  // Justify: full lines fill the width; headings and each paragraph's last line stay ragged.
  const justified = layout(story, 30, { align: "justify" })
  const lastOfParagraph = new Set(justified.flatMap((l, i) => (justified[i + 1]?.text ?? "") === "" ? [i] : []))
  justified.forEach((l, i) => {
    if (l.heading || l.text === "" || lastOfParagraph.has(i) || l.text === "Short line") return
    assert.equal(l.text.length, 30, `"${l.text}"`)
  })
  assert.ok(justified.filter((l) => l.heading && l.text).every((l) => !l.text.includes("  ")))
  assert.ok(text({ align: "justify" }).at(-1)!.length < 30)
  assert.equal(justify("a b c", 9), "a   b   c")
  assert.equal(justify("a b c", 8), "a   b  c")
  assert.equal(justify("word", 10), "word")
})

test("the text column is centred and capped", () => {
  assert.deepEqual(column(120, 80), { width: 80, margin: 20 })
  assert.deepEqual(column(60, 80), { width: 60, margin: 0 })
  assert.deepEqual(column(121, 66), { width: 66, margin: 27 })
  assert.deepEqual(column(120, "full"), { width: 120, margin: 0 })
})

test("changing a display setting keeps the first displayed text on the top line", () => {
  const height = 9
  for (const from of modes) {
    const lines = layout(story, 34, from)
    for (let offset: number | undefined = 0; offset !== undefined; offset = nextScreen(lines, height, offset)) {
      for (const to of modes) {
        const after: Line = screenAt(layout(story, 34, to), height, offset).lines[0]
        assert.ok(holds(after, offset), `${JSON.stringify(from)} → ${JSON.stringify(to)}`)
      }
    }
  }
})

test("contents lists chapters with text, titled from the TOC or numbered", () => {
  assert.deepEqual(contents([0, 100, 0, 300], [undefined, "One", "Cover", undefined]), [
    { spine: 1, title: "One", percent: 0 },
    { spine: 3, title: "Chapter 4", percent: 25 },
  ])
  assert.deepEqual(contents([], []), [])
})

test("Boox hint only when OpenCode is at least 1 % ahead", () => {
  assert.equal(booxHint(47.8, 40), 47)
  assert.equal(booxHint(40.9, 40), undefined)
  assert.equal(booxHint(30, 40), undefined)
  assert.equal(booxHint(30, undefined), undefined)
})

test("only page turns count as local reading, not opening at the Boox position", () => {
  const boox = { lastAccess: 5, percent: 40 }
  const previous = { updatedAt: 4, openedAt: 3 }
  const opened = savedTimes(previous, { opened: true, now: 10 })
  assert.deepEqual(opened, { updatedAt: 4, openedAt: 10 })
  assert.equal(chooseStart(opened, boox), "boox")
  assert.deepEqual(savedTimes(undefined, { opened: true, now: 10 }), { updatedAt: 0, openedAt: 10 })
  assert.deepEqual(savedTimes(opened, { opened: false, now: 11 }), { updatedAt: 4, openedAt: 10 })
  const turned = savedTimes(opened, { turnedAt: 12, opened: false, now: 12 })
  assert.deepEqual(turned, { updatedAt: 12, openedAt: 10 })
  assert.equal(chooseStart(turned, boox), "local")
  // The save comes up to a second after the turn: the turn's time is kept, so a
  // Boox save in between stays newer.
  const late = savedTimes(opened, { turnedAt: 6, opened: false, now: 6.8 })
  assert.equal(late.updatedAt, 6)
  assert.equal(chooseStart(late, { lastAccess: 6.5, percent: 40 }), "boox")
})

test("opens at the Boox position only when the Boox read is newer", () => {
  assert.equal(chooseStart(undefined, { lastAccess: 5, percent: 10 }), "boox")
  assert.equal(chooseStart({ updatedAt: 4 }, { lastAccess: 5, percent: 10 }), "boox")
  assert.equal(chooseStart({ updatedAt: 6 }, { lastAccess: 5, percent: 10 }), "local")
  assert.equal(chooseStart(undefined, { lastAccess: 0, percent: 10 }), "local")
  assert.equal(chooseStart(undefined, { lastAccess: 5 }), "local")
  assert.equal(chooseStart(undefined, undefined), "local")
})

test("a book is finished at 100 % here, or on the Boox unless read here since", () => {
  assert.equal(isFinished({ percent: 100, updatedAt: 5 }), true)
  assert.equal(isFinished({ percent: 99.9, updatedAt: 5 }), false)
  assert.equal(isFinished({ percent: 40, updatedAt: 5 }, { percent: 100, lastAccess: 9 }), true)
  assert.equal(isFinished({ percent: 40, updatedAt: 0 }, { percent: 100, lastAccess: 0 }), true)
  // Turned back here after the Boox finished it: reading again.
  assert.equal(isFinished({ percent: 40, updatedAt: 10 }, { percent: 100, lastAccess: 9 }), false)
  assert.equal(isFinished({ percent: 40, updatedAt: 0 }, { percent: 99, lastAccess: 9 }), false)
  // Finished on the Boox (opened there at 9), its position pulled here at 20, no page turned since: still finished.
  const pulled = { percent: 99, updatedAt: 20, pulledAt: 20 }
  assert.equal(isFinished(pulled, { percent: 100, lastAccess: 9 }), true)
  // One page turned here after the pull: reading again.
  assert.equal(isFinished({ ...pulled, updatedAt: 25 }, { percent: 100, lastAccess: 9 }), false)
  // A pull of an unfinished Boox position finishes nothing.
  assert.equal(isFinished(pulled, { percent: 99, lastAccess: 9 }), false)
  // Stored before `pulledAt` existed: as before.
  assert.equal(isFinished({ percent: 40, updatedAt: 20 }, { percent: 100, lastAccess: 9 }), false)
  assert.equal(isFinished({ percent: 40, updatedAt: 5 }, { percent: 100, lastAccess: 9 }), true)
})

test("a window holding an older reading never overwrites a newer stored one", () => {
  // Window B turned to a later page at 200 and saved; window A still holds its position read at 100.
  assert.equal(keepsStored({ updatedAt: 200 }, 100), true)
  assert.equal(keepsStored({ updatedAt: 200 }, 200), false) // Its own save.
  // A pull answer is applied only if no window read since it was asked (stored 200 then).
  assert.equal(keepsStored({ updatedAt: 250 }, 200), true)
  assert.equal(keepsStored({ updatedAt: 200 }, 200), false)
  assert.equal(keepsStored({ updatedAt: 100 }, 250), false) // A turned a page since: A wins.
  assert.equal(keepsStored({ updatedAt: 100 }, 0), true) // Opened without turning, after another window read.
  assert.equal(keepsStored(undefined, 0), false)
})
