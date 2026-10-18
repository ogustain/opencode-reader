/**
 * Pure pagination and position arithmetic.
 *
 * A position is `{ spine, offset }`: a chapter and a character offset in it
 * (see `chapterLength`), independent of the panel size. The screen shown
 * starts at the line holding the position and runs `height` lines; turning a
 * page moves the position to the next screen's first line. A resize only
 * re-wraps: the first character shown stays on the top line, and the position
 * itself never moves without a page turn.
 */
import type { Paragraph } from "./text.ts"

export type Position = { spine: number; offset: number }
/** A wrapped line; `start` is the offset of its first character (for a blank line, the newline before the next text). */
export type Line = { text: string; start: number; heading?: true }

/** Display settings of the panel, persisted by the TUI. */
export type Display = {
  /** Text column width in cells, centred in a wider panel. */
  width: "full" | 100 | 80 | 66
  /** A blank line between paragraphs, or none and a 2-space first-line indent. */
  paragraphs: "blank" | "indent"
  /** "airy": a blank line after every line of text. */
  lines: "normal" | "airy"
  align: "left" | "justify"
}
export const defaultDisplay: Display = { width: 80, paragraphs: "blank", lines: "normal", align: "left" }

/** Text column for a panel `available` cells wide: its width and left margin. */
export function column(available: number, width: Display["width"]): { width: number; margin: number } {
  const cols = width === "full" ? available : Math.min(available, width)
  return { width: cols, margin: Math.max(0, Math.floor((available - cols) / 2)) }
}

/** Pads the gaps between words, leftmost first, to fill `width` cells. */
export function justify(text: string, width: number): string {
  const words = text.split(" ")
  const extra = width - text.length
  if (words.length < 2 || extra <= 0) return text
  const gaps = words.length - 1
  return words.reduce((out, word, i) => out + " ".repeat(1 + Math.floor(extra / gaps) + (i - 1 < extra % gaps ? 1 : 0)) + word)
}

/**
 * Wraps paragraphs to `width` cells. Blank lines between paragraphs start at
 * the newline before the next one, so a screen can begin with one; "airy"
 * spacers share the next line's start, so a screen never begins with one.
 * Justification never touches headings or the last line of a paragraph.
 */
export function layout(paragraphs: readonly Paragraph[], width: number, display: Partial<Display> = {}): Line[] {
  const { paragraphs: spacing, lines: leading, align } = { ...defaultDisplay, ...display }
  const cols = Math.max(8, Math.floor(width))
  const lines: Line[] = []
  let base = 0
  let afterHeading = false
  for (const paragraph of paragraphs) {
    // With indents, blank lines remain only around headings.
    if (lines.length > 0 && (spacing === "blank" || paragraph.heading || afterHeading)) lines.push({ text: "", start: base - 1 })
    const heading = paragraph.heading ? { heading: true as const } : {}
    let prefix = spacing === "indent" && !paragraph.heading ? "  " : ""
    let segmentStart = base
    for (const segment of paragraph.text.split("\n")) {
      if (segment.length === 0) lines.push({ text: "", start: segmentStart, ...heading })
      let i = 0
      while (i < segment.length) {
        const room = Math.max(1, cols - prefix.length)
        if (segment.length - i <= room) {
          lines.push({ text: prefix + segment.slice(i), start: segmentStart + i, ...heading })
          break
        }
        const cut = segment.lastIndexOf(" ", i + room)
        if (cut > i) {
          const text = segment.slice(i, cut)
          lines.push({ text: prefix + (align === "justify" && !paragraph.heading ? justify(text, room) : text), start: segmentStart + i, ...heading })
          i = cut + 1
        } else {
          lines.push({ text: prefix + segment.slice(i, i + room), start: segmentStart + i, ...heading })
          i += room
        }
        prefix = ""
      }
      prefix = ""
      segmentStart += segment.length + 1
    }
    base += paragraph.text.length + 1
    afterHeading = !!paragraph.heading
  }
  if (leading === "normal") return lines
  return lines.flatMap((line, i) => {
    const next = lines[i + 1]
    return next && line.text !== "" ? [line, { text: "", start: next.start }] : [line]
  })
}

/** Index of the line holding `offset`: the last line starting at or before it. */
export function lineAt(lines: readonly Line[], offset: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= offset) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/**
 * The screen at `offset`: only its visible lines, from the line holding the
 * offset. `page`/`pages` (0-based / count) count whole screens before and from
 * it, so the last screen of a chapter is always page `pages - 1`.
 */
export function screenAt(lines: readonly Line[], height: number, offset: number) {
  const h = Math.max(1, height)
  const first = lineAt(lines, offset)
  const page = Math.ceil(first / h)
  return { first, lines: lines.slice(first, first + h), page, pages: page + Math.max(1, Math.ceil((lines.length - first) / h)) }
}

/** Offset of the next screen in the chapter, undefined on its last screen. */
export function nextScreen(lines: readonly Line[], height: number, offset: number): number | undefined {
  return lines[lineAt(lines, offset) + Math.max(1, height)]?.start
}

/** Offset of the previous screen in the chapter, undefined on its first line. */
export function previousScreen(lines: readonly Line[], height: number, offset: number): number | undefined {
  const first = lineAt(lines, offset)
  return first > 0 ? lines[Math.max(0, first - Math.max(1, height))].start : undefined
}

/** Offset of a chapter's last full screen (0 for an empty or short chapter). */
export function lastScreen(lines: readonly Line[], height: number): number {
  return lines[Math.max(0, lines.length - Math.max(1, height))]?.start ?? 0
}

/** Global percentage (0–100) of a position, from the chapter lengths of the book. */
export function toPercent(chapters: readonly number[], position: Position): number {
  let total = 0
  let before = 0
  chapters.forEach((chars, i) => {
    total += chars
    if (i < position.spine) before += chars
  })
  if (total <= 0) return 0
  const inChapter = Math.min(Math.max(0, position.offset), chapters[position.spine] ?? 0)
  return Math.min(100, Math.max(0, ((before + inChapter) / total) * 100))
}

/** Position at a global percentage; approximate, lands inside a non-empty chapter. */
export function fromPercent(chapters: readonly number[], percent: number): Position {
  const total = chapters.reduce((a, b) => a + b, 0)
  if (total <= 0) return { spine: 0, offset: 0 }
  const target = (Math.min(100, Math.max(0, percent)) / 100) * total
  let acc = 0
  let last: Position = { spine: 0, offset: 0 }
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i] <= 0) continue
    if (target < acc + chapters[i]) return { spine: i, offset: Math.floor(target - acc) }
    acc += chapters[i]
    last = { spine: i, offset: chapters[i] }
  }
  return last
}

/** Next (dir 1) or previous (dir -1) chapter with text, or undefined at the ends. */
export function nextChapter(chapters: readonly number[], spine: number, dir: 1 | -1): number | undefined {
  for (let i = spine + dir; i >= 0 && i < chapters.length; i += dir) if (chapters[i] > 0) return i
  return undefined
}

/**
 * On the last screen of a book with text: this chapter has text (its wrapped
 * `lines`), no next screen in it and no later chapter with text.
 */
export function atBookEnd(chapters: readonly number[], spine: number, lines: readonly Line[], height: number, offset: number): boolean {
  return lines.length > 0 && nextScreen(lines, height, offset) === undefined && nextChapter(chapters, spine, 1) === undefined
}

/**
 * A forward page turn from `from`, on its chapter's wrapped `lines`: the next
 * screen, else the first one of the next chapter with text (`wrapChapter`
 * lays it out), else `from` itself (`end`). It finishes the book when it lands
 * on the last screen of a book with text, or presses on from it: the only way
 * a book becomes finished (opening, resizing or restoring never do).
 */
export async function turnForward(
  chapters: readonly number[],
  from: Position,
  lines: readonly Line[],
  height: number,
  wrapChapter: (spine: number) => Promise<readonly Line[] | undefined>,
): Promise<{ to: Position; end: boolean; finished: boolean }> {
  const offset = nextScreen(lines, height, from.offset)
  if (offset !== undefined) return { to: { spine: from.spine, offset }, end: false, finished: atBookEnd(chapters, from.spine, lines, height, offset) }
  const next = nextChapter(chapters, from.spine, 1)
  if (next === undefined) return { to: from, end: true, finished: atBookEnd(chapters, from.spine, lines, height, from.offset) }
  const nextLines = await wrapChapter(next)
  return { to: { spine: next, offset: 0 }, end: false, finished: !!nextLines && atBookEnd(chapters, next, nextLines, height, 0) }
}

/** Reopening at the position of a finish saved by a page turn keeps it; nothing else does. */
export function savedFinish(saved: { spine: number; offset: number; finished?: boolean } | undefined, position: Position): boolean {
  return saved?.finished === true && saved.spine === position.spine && saved.offset === position.offset
}

/**
 * Progress shown and sent: 100 % only for a finished book (its position is
 * the start of the last screen, short of the end), else the position's
 * percentage, at most 99.
 */
export function progressOf(chapters: readonly number[], position: Position, finished: boolean): number {
  return finished ? 100 : Math.min(99, toPercent(chapters, position))
}

/** Table of contents: chapters with text, titled from the TOC or "Chapter N", with the % at their start. */
export function contents(
  chapters: readonly number[],
  titles: ReadonlyArray<string | undefined>,
): Array<{ spine: number; title: string; percent: number }> {
  return chapters.flatMap((chars, spine) =>
    chars > 0 ? [{ spine, title: titles[spine] ?? `Chapter ${spine + 1}`, percent: toPercent(chapters, { spine, offset: 0 }) }] : [],
  )
}

/**
 * A book read to the end: 100 % here, or finished on the Boox (100 %) with no
 * page turn here since the Boox last read it (re-reading here wins).
 */
export function isFinished(local: { percent: number; updatedAt: number }, boox?: { percent: number; lastAccess: number }): boolean {
  return local.percent >= 100 || (!!boox && boox.percent >= 100 && boox.lastAccess >= local.updatedAt)
}

/** "Boox: go to N %" when OpenCode is at least 1 % ahead of the last known Boox position. */
export function booxHint(localPercent: number, booxPercent: number | undefined): number | undefined {
  if (booxPercent === undefined || !Number.isFinite(booxPercent)) return undefined
  return localPercent - booxPercent >= 1 ? Math.floor(localPercent) : undefined
}

/**
 * Timestamps of a saved position. Only a page turn by the reader bumps
 * `updatedAt`, to the time of the turn (`turnedAt`), not of the save that
 * follows it; opening or resuming a book, even at a different position such as
 * the Boox's, keeps it, so it never looks like a newer read than the Boox.
 */
export function savedTimes(
  previous: { updatedAt: number; openedAt?: number } | undefined,
  event: { turnedAt?: number; opened: boolean; now: number },
): { updatedAt: number; openedAt?: number } {
  return {
    updatedAt: event.turnedAt ?? previous?.updatedAt ?? 0,
    openedAt: event.opened ? event.now : previous?.openedAt,
  }
}

/** Where to open a Boox book: its Boox position when read there more recently. */
export function chooseStart(
  local: { updatedAt: number } | undefined,
  boox: { lastAccess: number; percent?: number } | undefined,
): "boox" | "local" {
  if (!boox || boox.percent === undefined || boox.lastAccess <= 0) return "local"
  return !local || boox.lastAccess > local.updatedAt ? "boox" : "local"
}
