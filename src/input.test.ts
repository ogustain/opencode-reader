import { test } from "node:test"
import assert from "node:assert/strict"
import { addSummary, cleanPath, cleanToken, commandArgument } from "./input.ts"

test("dragged paths lose their quotes and backslash escapes", () => {
  assert.equal(cleanPath("  /Users/me/My\\ Books/a\\ \\(1\\).epub "), "/Users/me/My Books/a (1).epub")
  assert.equal(cleanPath("'/Users/me/My Books/it\\'s.epub'"), "/Users/me/My Books/it\\'s.epub")
  assert.equal(cleanPath('"/Users/me/My Books/a.epub"'), "/Users/me/My Books/a.epub")
  assert.equal(cleanPath("~/Books/a.epub"), "~/Books/a.epub")
  assert.equal(cleanPath("file:///Users/me/My%20Books/a.epub"), "/Users/me/My Books/a.epub")
  assert.equal(cleanPath("   "), "")
})

test("the slash command argument, with or without the command", () => {
  assert.equal(commandArgument(undefined, "add"), "")
  assert.equal(commandArgument("", "add"), "")
  assert.equal(commandArgument("/add", "add"), "")
  assert.equal(commandArgument("/add ~/a.epub ", "add"), "~/a.epub")
  assert.equal(commandArgument(" ~/a.epub", "add"), "~/a.epub")
  assert.equal(commandArgument("/addendum.epub", "add"), "/addendum.epub")
})

test("tokens lose blanks and quotes", () => {
  assert.equal(cleanToken(' "a.b.c"\n'), "a.b.c")
  assert.equal(cleanToken(42), "")
})

test("the add summary counts each outcome", () => {
  const book = { path: "", key: "", title: "" }
  assert.equal(
    addSummary({
      added: [book, book],
      skipped: [{ reason: "already there" }, { reason: "protected (DRM)" }, { reason: "not an EPUB" }, { reason: "not an EPUB" }],
    }),
    "2 added · 1 already there · 1 refused (DRM) · 2 refused (not an EPUB)",
  )
  assert.equal(addSummary({ added: [], skipped: [] }), "")
})
