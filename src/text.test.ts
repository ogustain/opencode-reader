import { test } from "node:test"
import assert from "node:assert/strict"
import { attributes, chapterLength, decodeEntities, noteBlock, noteText, xhtmlToParagraphs } from "./text.ts"

test("decodes named and numeric entities, leaves unknown ones", () => {
  assert.equal(decodeEntities("&eacute;t&eacute; &amp; &#8217;&#x2014;&hellip; &laquo;x&raquo; &bogus; &#xZZ;"), "été & ’—… «x» &bogus; &#xZZ;")
  assert.equal(decodeEntities("&#1114112;"), "&#1114112;")
})

test("parses attributes with both quote styles", () => {
  assert.deepEqual(attributes(` id="a" href='b%20c.xhtml' media-type="x&amp;y"`), { id: "a", href: "b%20c.xhtml", "media-type": "x&y" })
})

test("XHTML to paragraphs: blocks, headings, breaks; drops head, script, style, images", () => {
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Ignored</title><style>p { color: red }</style><script>alert(1)</script></head>
<body>
  <section>
    <h2 class="t">Chapitre <span>1</span></h2>
    <p>Il   était
       une <em>fois</em>&#160;!</p>
    <p>Vers un<br/>vers deux</p>
    <div><img src="a.png" alt="pic"/></div>
    <!-- comment <p>not text</p> -->
    <p>Fin&shy;ale.</p>
    <ul><li>un</li><li>deux</li></ul>
  </section>
</body>
</html>`
  assert.deepEqual(xhtmlToParagraphs(xhtml), [
    { text: "Chapitre 1", heading: true },
    { text: "Il était une fois\u00a0!" },
    { text: "Vers un\nvers deux" },
    { text: "Finale." },
    { text: "un" },
    { text: "deux" },
  ])
})

test("text outside block tags still forms a paragraph; NFC normalized", () => {
  assert.deepEqual(xhtmlToParagraphs("<body>loose e\u0301 text<p>para</p>tail</body>"), [{ text: "loose é text" }, { text: "para" }, { text: "tail" }])
})

test("<sup> and <sub> text in Unicode forms, one for one; a run with a character lacking one unchanged", () => {
  const note = '<span class="calibre14"><a class="sdfootnoteanc" href="../Text/n.html#sdfootnote11sym" id="sdfootnote11anc"><sup>11</sup></a></span>'
  assert.deepEqual(xhtmlToParagraphs(`<body><p><span>Marie</span><sup class="calibre13">${note}</sup>, dit-il.</p></body>`).map((p) => p.text), ["Marie¹¹, dit-il."])
  assert.deepEqual(xhtmlToParagraphs("<body><p>XIX<sup>e</sup> siècle, H<sub>2</sub>O, 1<sup>er</sup></p></body>"), [{ text: "XIXᵉ siècle, H₂O, 1ᵉʳ" }])
  assert.deepEqual(xhtmlToParagraphs("<body><p>M<sup>me</sup>, x<sup>2a</sup>, n<sub>e</sub></p></body>"), [{ text: "Mme, x2a, ne" }])
})

test("note references: an <a> to a fragment inside <sup> or marked noteref, the text unchanged", () => {
  const calibre =
    '<sup class="calibre13"><span class="calibre14"><a class="sdfootnoteanc" href="../Text/notes.html#sdfootnote11sym" id="sdfootnote11anc"><sup>11</sup></a></span></sup>'
  assert.deepEqual(xhtmlToParagraphs(`<body><p>  Dit <span>Paul</span>${calibre}, puis.</p></body>`), [
    { text: "Dit Paul¹¹, puis.", notes: [{ at: 8, label: "¹¹", href: "../Text/notes.html#sdfootnote11sym" }] },
  ])
  const epub3 = '<body><p>Un mot<a epub:type="noteref" href="#n1">1</a> et<br/>un autre<sup><a href="#n2">2</a></sup>.</p></body>'
  assert.deepEqual(xhtmlToParagraphs(epub3), [
    { text: "Un mot1 et\nun autre².", notes: [{ at: 6, label: "1", href: "#n1" }, { at: 19, label: "²", href: "#n2" }] },
  ])
  // No fragment, an external link, or a plain link: not notes.
  const links = '<body><p>a<sup><a href="../Text/x.html">2</a></sup> b<sup><a href="http://example.org/#x">3</a></sup> c<a href="#x">4</a></p></body>'
  assert.deepEqual(xhtmlToParagraphs(links), [{ text: "a² b³ c4" }])
})

test("a note's text: the element with the id, or the block around an inline one", () => {
  const notes =
    '<html><body><div class="calibre3" id="sdfootnote11"><p class="sdfootnote-western"><a class="sdfootnotesym-western" href="../Text/ch.html#sdfootnote11anc" id="sdfootnote11sym">11</a> Voir la lettre du <i>3 mai</i>.</p></div>' +
    '<aside epub:type="footnote" id="n1"><p>1. Première note.</p><p>Suite.</p></aside><p>Fin.</p></body></html>'
  assert.equal(noteText(notes, "sdfootnote11sym"), "11 Voir la lettre du 3 mai.")
  assert.equal(noteText(notes, "sdfootnote11"), "11 Voir la lettre du 3 mai.")
  assert.equal(noteText(notes, "n1"), "1. Première note.\nSuite.")
  assert.equal(noteText(notes, "missing"), undefined)
  // Shown after its label, without the number it starts with.
  assert.equal(noteBlock("¹¹", "11 Voir la lettre du 3 mai."), "¹¹ Voir la lettre du 3 mai.")
  assert.equal(noteBlock("¹", "1. Première note."), "¹ Première note.")
  assert.equal(noteBlock("¹", "12 mai."), "¹ 12 mai.")
})

test("chapter length counts each paragraph plus a separator", () => {
  assert.equal(chapterLength([{ text: "abc" }, { text: "de" }]), 7)
  assert.equal(chapterLength([]), 0)
})
