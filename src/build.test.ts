import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = join(import.meta.dirname, "..")

test("dist/tui.js is up to date with src/tui.tsx (run `npm run build:tui`)", () => {
  const fresh = execFileSync(process.execPath, [join(root, "scripts", "build-tui.mjs"), "--print"], { cwd: root, encoding: "utf8" })
  const committed = readFileSync(join(root, "dist", "tui.js"), "utf8")
  assert.ok(committed === fresh, "dist/tui.js is stale: run `npm run build:tui`")
})

test("dist/tui.js uses Solid's universal JSX and the TypeScript sources", () => {
  const code = readFileSync(join(root, "dist", "tui.js"), "utf8")
  const sources = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])
  assert.ok(sources.includes("@opentui/solid"))
  assert.ok(sources.includes("solid-js"))
  assert.ok(sources.includes("@opencode/plugin/tui"))
  assert.ok(!sources.some((s) => s === "react" || s.startsWith("react/")))
  for (const s of sources.filter((s) => s.startsWith("."))) assert.match(s, /^\.\.\/src\/[\w-]+\.ts$/)
})
