/**
 * XHTML chapter → plain paragraphs for a terminal page. Block tags end a
 * paragraph, `<br>` is a line break inside one, headings are flagged, and
 * head/script/style/images are dropped. Not a full HTML parser: EPUB content
 * documents are well-formed XHTML, which keeps a tag scanner sufficient.
 */

export type Paragraph = { text: string; heading?: true }

/** HTML 4 Latin-1 entities, code points 160–255 in order. */
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"

const ENTITIES: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376,
  fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206,
  rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, rarr: 8594, minus: 8722, laquo: 171,
}
LATIN1.split(" ").forEach((name, i) => (ENTITIES[name] = 160 + i))

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    const code =
      body[0] === "#" ? (body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)) : ENTITIES[body]
    if (code === undefined || !Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
    try {
      return String.fromCodePoint(code)
    } catch {
      return match
    }
  })
}

/** Attributes of a start tag body (`a="x" b='y'`), values entity-decoded. */
export function attributes(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "")
  return out
}

const BLOCK = new Set([
  "p", "div", "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "section", "article", "aside", "header", "footer",
  "nav", "figure", "figcaption", "table", "tr", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "body", "main",
  "address", "center", "caption", "tbody", "thead",
])
const DROP = ["head", "script", "style", "svg", "math", "noscript", "template"]

/** Superscript and subscript forms, one UTF-16 unit per character so offsets are unchanged. */
const RAISED: Record<string, string> = { sup: "0⁰1¹2²3³4⁴5⁵6⁶7⁷8⁸9⁹nⁿiⁱeᵉrʳdᵈoᵒ", sub: "0₀1₁2₂3₃4₄5₅6₆7₇8₈9₉" }
const FORMS = Object.fromEntries(Object.entries(RAISED).map(([tag, pairs]) => [tag, new Map([...pairs.matchAll(/(.)(.)/gu)].map((m) => [m[1], m[2]]))]))
const LOWER = new Map([...FORMS.sup, ...FORMS.sub].map(([a, b]) => [b, a]))
/** Text with those forms back to their characters (same length): what the source said. */
export function lowered(text: string): string {
  return text.replace(/[⁰¹²³⁴-⁹ⁿⁱᵉʳᵈᵒ₀-₉]/g, (c) => LOWER.get(c) ?? c)
}
/** A text run inside `<sup>`/`<sub>` in their forms, or unchanged when one character (spaces aside) has none. */
function raise(run: string, forms: Map<string, string>): string {
  const chars = [...run]
  return chars.every((c) => forms.has(c) || /\s/.test(c)) ? chars.map((c) => forms.get(c) ?? c).join("") : run
}

export function xhtmlToParagraphs(xhtml: string): Paragraph[] {
  let html = xhtml
    .replace(/\u0000/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[!?][^>]*>/g, "")
  for (const tag of DROP) html = html.replace(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[\\s\\S]*?</(?:[\\w-]+:)?${tag}\\s*>`, "gi"), " ")
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)
  if (body) html = body[1]

  const paragraphs: Paragraph[] = []
  let current = ""
  let heading = 0
  const depth = { sup: 0, sub: 0 }
  const flush = () => {
    const text = clean(current)
    if (text) paragraphs.push(heading > 0 ? { text, heading: true } : { text })
    current = ""
  }
  for (const m of html.matchAll(/<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const tag = depth.sup > 0 ? "sup" : depth.sub > 0 ? "sub" : undefined
      current += tag ? raise(m[4], FORMS[tag]) : m[4]
      continue
    }
    const name = m[2].toLowerCase().replace(/^.*:/, "")
    if ((name === "sup" || name === "sub") && !m[3]) depth[name] = Math.max(0, depth[name] + (m[1] ? -1 : 1))
    if (name === "br") {
      current += BREAK
      continue
    }
    if (!BLOCK.has(name)) continue
    flush()
    if (/^h[1-6]$/.test(name) && !m[3]) heading = Math.max(0, heading + (m[1] ? -1 : 1))
  }
  flush()
  return paragraphs
}

/** Marks a `<br>` until whitespace is collapsed (source newlines are not breaks). */
const BREAK = "\u0000"

/** Collapses markup whitespace, keeps `<br>` breaks and no-break spaces. */
function clean(raw: string): string {
  return raw
    .split(BREAK)
    .map((line) =>
      decodeEntities(line.replace(/[ \t\r\f\n]+/g, " "))
        .replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, "")
        .trim(),
    )
    .filter((line, i, lines) => line || (i > 0 && i < lines.length - 1))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .normalize("NFC")
}

/** Characters of a chapter as positions count them: each paragraph plus one separator. */
export function chapterLength(paragraphs: readonly Paragraph[]): number {
  let total = 0
  for (const p of paragraphs) total += p.text.length + 1
  return total
}
