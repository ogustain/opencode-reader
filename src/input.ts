/**
 * What the reader types or drops into the TUI's prompts: pure helpers, shared
 * by the TUI (which cannot import the file-system modules) and the tests.
 */

/**
 * A path as typed or dragged into the terminal: surrounding quotes removed,
 * else the backslash escapes of a drag and drop (`My\ Books/a\ \(1\).epub`)
 * undone; a `file://` URL becomes its path.
 */
export function cleanPath(input: string): string {
  let path = input.trim()
  const quoted = /^(["'])(.*)\1$/s.exec(path)
  if (quoted) path = quoted[2]
  else path = path.replace(/\\([^A-Za-z0-9])/g, "$1")
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      // Kept as typed.
    }
  }
  return path.trim()
}

/**
 * True for text that can name a file: absolute, `~` or relative to the
 * current folder. A PDF or image dropped into OpenCode's prompt becomes an
 * attachment, and the command receives its label instead of a path.
 */
export const looksLikePath = (path: string) => /^(\/|~(\/|$)|\.\.?(\/|$))/.test(path)

/** The argument of a slash command, with or without the command itself in front. */
export function commandArgument(input: string | undefined, name: string): string {
  const text = (input ?? "").trim()
  const prefix = `/${name}`
  return (text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`) ? text.slice(prefix.length) : text).trim()
}

/** A pasted token: without blanks around it or the quotes copied with the value. */
export function cleanToken(input: unknown): string {
  if (typeof input !== "string") return ""
  return input.trim().replace(/^(["'])(.*)\1$/s, "$2").trim()
}

/** True for an outcome that refuses nothing: the book is in the library (already, or now). */
export const alreadyIn = (reason: string) => reason === "already there" || reason.startsWith("already in the library")

/**
 * "2 moved to the library · 1 already there · 1 refused (DRM)": one count per
 * outcome, in order of first appearance. A book copied but whose original was
 * kept says why: "1 copied; original kept (symbolic link)".
 */
export function addSummary(result: { added: Array<{ kept?: string }>; skipped: Array<{ reason: string }> }): string {
  const counts = new Map<string, number>()
  const count = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1)
  for (const { kept } of result.added) count(kept ? `copied; original kept (${kept})` : "moved to the library")
  for (const { reason } of result.skipped)
    count(alreadyIn(reason) || reason === "not found" ? reason : `refused (${reason === "protected (DRM)" ? "DRM" : reason})`)
  return [...counts].map(([label, n]) => `${n} ${label}`).join(" · ")
}
