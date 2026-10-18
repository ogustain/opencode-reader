/**
 * NeoReader positions ↔ the plugin's `{ spine, offset }`.
 *
 * NeoReader stores a reflowable-book position as a JSON-like string whose
 * numbers are zero-padded to 10 digits (not strict JSON), for example
 * `{"chapterIndex":0000000007,"nodePosition":0000000826,"textOffset":0000000924,
 * "chapterStartPosition":0000035268,"chapterEndPosition":0000039293,
 * "chapterID":"id2.7","xpath":[0,1,5,0,0]}`. Verified on 25 cloud positions
 * against the EPUB files (see docs/plans/reader-plugin.md):
 *
 * - `chapterIndex`: index of the `<itemref>` in the OPF spine; `chapterID` its idref.
 * - `chapterStartPosition` / `chapterEndPosition`: UTF-8 byte offsets of the
 *   chapter document in the concatenation of all spine documents.
 * - `xpath`: child-node indices from the document down to a text node (or an
 *   element, then `textOffset` is 0). The XML declaration is not a node;
 *   whitespace text, the doctype and comments are, at every level. So
 *   `[1,3,0,1,1]` after `<?xml …?>\n` is "\n"(0) html(1) → body(3) → div(0) →
 *   p(1) → text(1), and `[3,…]` after `<?xml …?>\n<!DOCTYPE …>\n` is html.
 * - `nodePosition`: index (UTF-16 units) of that node in the chapter source.
 * - `textOffset` (`textStartOffset`/`textEndOffset` in annotations): offset in
 *   the node's decoded text.
 * - An empty `xpath` with zeros means the chapter start.
 *
 * Text nodes are aligned with the plugin's paragraphs (`xhtmlToParagraphs`) on
 * their non-space characters, so both directions are exact to the character.
 */
import { chapterLength, decodeEntities, xhtmlToParagraphs, type Paragraph } from "./text.ts"

// ---------------------------------------------------------------------------
// The position string

export type NeoValue = number | string | number[] | null
/** A position string's fields, in their original order. */
export type NeoPosition = ReadonlyArray<readonly [string, NeoValue]>

/** Key order NeoReader writes for a reading position. */
export const NEO_KEYS = ["chapterIndex", "nodePosition", "textOffset", "chapterStartPosition", "chapterEndPosition", "chapterID", "xpath"]

/** Parses a position string, tolerating zero-padded numbers. Undefined when it is not one. */
export function parseNeoPosition(text: unknown): NeoPosition | undefined {
  if (typeof text !== "string" || !text.startsWith("{")) return undefined
  // Unpad numbers outside strings, then parse as JSON.
  let json = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      json += c
      if (c === "\\") json += text[++i] ?? ""
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      json += c
    } else if (/[0-9]/.test(c)) {
      let j = i
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++
      const number = Number(text.slice(i, j))
      if (!Number.isFinite(number)) return undefined
      json += String(number)
      i = j - 1
    } else json += c
  }
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, v as NeoValue] as const)
  } catch {
    return undefined
  }
}

const pad = (n: number) => (Number.isInteger(n) && n >= 0 ? String(n).padStart(10, "0") : String(n))

/** Serializes back with NeoReader's layout: top-level numbers padded to 10 digits, arrays not. */
export function formatNeoPosition(position: NeoPosition): string {
  const value = (v: NeoValue) =>
    typeof v === "number" ? pad(v) : Array.isArray(v) ? `[${v.map((n) => String(n)).join(",")}]` : JSON.stringify(v)
  return `{${position.map(([key, v]) => `${JSON.stringify(key)}:${value(v)}`).join(",")}}`
}

/** Replaces fields in place (same order); new fields are appended in NeoReader's order. */
export function withNeoFields(position: NeoPosition | undefined, fields: Record<string, NeoValue>): NeoPosition {
  const out = (position ?? []).map(([key, v]) => [key, key in fields ? fields[key] : v] as const)
  const present = new Set(out.map(([key]) => key))
  const missing = Object.keys(fields).sort((a, b) => rank(a) - rank(b))
  for (const key of missing) if (!present.has(key)) out.push([key, fields[key]] as const)
  return out
}
const rank = (key: string) => (NEO_KEYS.includes(key) ? NEO_KEYS.indexOf(key) : NEO_KEYS.length)

export type NeoPoint = {
  chapterIndex: number
  nodePosition: number
  textOffset: number
  chapterStartPosition?: number
  chapterEndPosition?: number
  chapterID?: string
  xpath: number[]
}

/** The fields of a position that locate it; undefined for other formats (PDF page references…). */
export function neoPoint(position: NeoPosition | undefined): NeoPoint | undefined {
  if (!position) return undefined
  const get = (key: string) => position.find(([k]) => k === key)?.[1]
  const num = (key: string) => (typeof get(key) === "number" ? (get(key) as number) : undefined)
  const chapterIndex = num("chapterIndex")
  if (chapterIndex === undefined) return undefined
  const xpath = get("xpath")
  return {
    chapterIndex,
    nodePosition: num("nodePosition") ?? 0,
    textOffset: num("textOffset") ?? num("textStartOffset") ?? 0,
    chapterStartPosition: num("chapterStartPosition"),
    chapterEndPosition: num("chapterEndPosition"),
    chapterID: typeof get("chapterID") === "string" ? (get("chapterID") as string) : undefined,
    xpath: Array.isArray(xpath) ? xpath.filter((n) => Number.isInteger(n)) : [],
  }
}

// ---------------------------------------------------------------------------
// Chapter text nodes

export type ChapterNode = {
  /** Child-node path from the document, as in `xpath`. */
  path: number[]
  /** Index of the node in the chapter source (`nodePosition`). */
  at: number
  /** Decoded text of a visible text node; undefined for elements. */
  text?: string
}

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "col", "area", "base", "wbr", "source", "embed", "param", "track"])
/** Content the plugin does not show (mirrors text.ts). */
const HIDDEN = new Set(["head", "script", "style", "svg", "math", "noscript", "template"])

/** Elements and visible text nodes (inside body, outside hidden elements) of a chapter, in document order. */
export function chapterNodes(xhtml: string): ChapterNode[] {
  type Frame = { name: string; count: number; path: number[]; hidden: boolean; body: boolean }
  const stack: Frame[] = [{ name: "#document", count: 0, path: [], hidden: false, body: false }]
  const nodes: ChapterNode[] = []
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g
  for (const m of xhtml.matchAll(re)) {
    const top = stack[stack.length - 1]
    const token = m[0]
    if (token.startsWith("<?")) continue // The XML declaration is not a node.
    if (token.startsWith("<!") && !token.startsWith("<![CDATA[")) {
      top.count++ // Doctype or comment.
      continue
    }
    const text = m[1] ?? m[6]
    if (text !== undefined) {
      const index = top.count++
      if (!top.hidden && top.body) nodes.push({ path: [...top.path, index], at: m.index!, text: m[1] !== undefined ? text : decodeEntities(text) })
      continue
    }
    const name = m[3].toLowerCase().replace(/^.*:/, "")
    if (m[2]) {
      const at = stack.findLastIndex((f) => f.name === name)
      if (at > 0) stack.length = at
      continue
    }
    const index = top.count++
    nodes.push({ path: [...top.path, index], at: m.index! })
    if (m[5] || VOID.has(name)) continue
    stack.push({ name, count: 0, path: [...top.path, index], hidden: top.hidden || HIDDEN.has(name), body: top.body || name === "body" })
  }
  return nodes
}

// ---------------------------------------------------------------------------
// Alignment with the plugin's paragraphs

export type ChapterMap = {
  nodes: ChapterNode[]
  paragraphs: Paragraph[]
  /** Characters of the chapter in the plugin's model (`chapterLength`). */
  chars: number
  sourceLength: number
  /** Per aligned character, in document order: node index, offset in the node, offset in the chapter. */
  node: Int32Array
  inNode: Int32Array
  offset: Int32Array
  count: number
}

const SPACE = /\s/
/** Characters `text.ts` removes. */
const REMOVED = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/
const REMOVED_ALL = /[\s\u00ad\u200b\u200c\u200d\u2060\ufeff]+/g
/** Code points NFC may fold into the previous one: combining marks, Hangul vowel and final jamo. */
const JOINS = /^[\p{M}\u1160-\u11ff\ud7b0-\ud7ff]$/u
const codePoint = (text: string, i: number) => String.fromCodePoint(text.codePointAt(i)!)

/**
 * Aligns each visible text node character with the plugin's chapter offsets.
 * The plugin's text is NFC, so the source is compared one NFC cluster (a
 * character and the code points that join it) at a time. Every step moves
 * forward in the source or in the plugin's text; past `maxSteps` the map is
 * left empty and positions fall back to proportional ones (`exact: false`).
 */
export function mapChapter(xhtml: string, options: { maxSteps?: number } = {}): ChapterMap {
  const paragraphs = xhtmlToParagraphs(xhtml)
  const flat = paragraphs.map((p) => p.text).join("\n")
  const nodes = chapterNodes(xhtml)
  const skeleton: number[] = []
  for (let i = 0; i < flat.length; i++) if (!SPACE.test(flat[i])) skeleton.push(i)
  const size = skeleton.length
  const node = new Int32Array(size)
  const inNode = new Int32Array(size)
  const offset = new Int32Array(size)
  let count = 0
  let k = 0
  const maxSteps = options.maxSteps ?? 2 * (xhtml.length + size) + 1000
  let steps = 0
  /** Length of `text` when it is the plugin's text at skeleton index `k`, else 0. */
  const matches = (text: string) => {
    if (!text || k + text.length > size) return 0
    for (let p = 0; p < text.length; p++) if (flat[skeleton[k + p]] !== text[p]) return 0
    return text.length
  }
  for (let index = 0; index < nodes.length; index++) {
    const t = nodes[index].text
    if (t === undefined) continue
    let i = 0
    while (i < t.length && k < size) {
      if (++steps > maxSteps) return { nodes, paragraphs, chars: chapterLength(paragraphs), sourceLength: xhtml.length, node, inNode, offset, count: 0 }
      const c = codePoint(t, i)
      if (SPACE.test(c) || REMOVED.test(c) || JOINS.test(c)) {
        i += c.length
        continue
      }
      let end = i + c.length
      while (end < t.length && JOINS.test(codePoint(t, end))) end += codePoint(t, end).length
      const cluster = t.slice(i, end).normalize("NFC").replace(REMOVED_ALL, "")
      const taken = matches(cluster) || matches(c)
      if (taken) {
        for (let p = 0; p < taken; p++) {
          node[count] = index
          inNode[count] = i
          offset[count] = skeleton[k]
          count++
          k++
        }
        i = taken === cluster.length ? end : i + c.length
        continue
      }
      // Out of step (markup the paragraph model treats differently): resync on the next few characters.
      const probe = t.slice(i).normalize("NFC").replace(REMOVED_ALL, "").slice(0, 12)
      let found = -1
      for (let j = k; j < Math.min(size, k + 400) && probe.length >= 4; j++) {
        let ok = true
        for (let p = 0; p < probe.length && ok; p++) ok = flat[skeleton[j + p]] === probe[p]
        if (ok) {
          found = j
          break
        }
      }
      if (found > k) k = found
      else if (found === k) i = end // Same place, but this cluster differs: drop it.
      else break // Skip the rest of this node.
    }
  }
  return { nodes, paragraphs, chars: chapterLength(paragraphs), sourceLength: xhtml.length, node, inNode, offset, count }
}

const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

/**
 * Chapter offset of a NeoReader point: the first character at or after it.
 * The node is found by xpath, else by nodePosition; `exact` is false when
 * neither matched and the offset is proportional to nodePosition.
 */
export function neoToOffset(map: ChapterMap, point: Pick<NeoPoint, "xpath" | "nodePosition" | "textOffset">): { offset: number; exact: boolean } {
  if (point.xpath.length === 0 && point.nodePosition === 0 && point.textOffset === 0) return { offset: 0, exact: true }
  let index = point.xpath.length ? map.nodes.findIndex((n) => samePath(n.path, point.xpath)) : -1
  if (index < 0) index = map.nodes.findIndex((n) => n.at === point.nodePosition)
  if (index < 0 || map.count === 0) {
    const ratio = Math.min(1, Math.max(0, (point.nodePosition + point.textOffset) / Math.max(1, map.sourceLength)))
    return { offset: Math.floor(ratio * map.chars), exact: false }
  }
  // An element points at its start: the offset inside it applies to text nodes only.
  const within = map.nodes[index].text === undefined ? 0 : point.textOffset
  for (let i = 0; i < map.count; i++) {
    if (map.node[i] > index || (map.node[i] === index && map.inNode[i] >= within)) return { offset: map.offset[i], exact: true }
  }
  return { offset: Math.max(0, map.chars - 1), exact: true }
}

/** NeoReader point (xpath, nodePosition, textOffset) of a chapter offset: the first character at or after it. */
export function offsetToNeo(map: ChapterMap, offset: number): { xpath: number[]; nodePosition: number; textOffset: number } {
  if (map.count === 0) return { xpath: [], nodePosition: 0, textOffset: 0 }
  let lo = 0
  let hi = map.count - 1
  let found = map.count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (map.offset[mid] >= offset) {
      found = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  const node = map.nodes[map.node[found]]
  return { xpath: [...node.path], nodePosition: node.at, textOffset: map.inNode[found] }
}
