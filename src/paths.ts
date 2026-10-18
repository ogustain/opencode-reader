/**
 * Where the plugin keeps its files: the book cache, the Onyx token, the sync
 * session and the push backups. `$XDG_DATA_HOME/opencode-reader`, default
 * `~/.local/share/opencode-reader`; the `dataDir` option overrides it.
 */
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** A relative `XDG_DATA_HOME` is ignored, as the XDG spec says. */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_DATA_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local/share"), "opencode-reader")
}
