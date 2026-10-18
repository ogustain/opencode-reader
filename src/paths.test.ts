import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { defaultCacheDir } from "./library.ts"
import { defaultBackupFile, defaultSessionFile, defaultTokenFile } from "./onyx.ts"
import { defaultDataDir } from "./paths.ts"

test("files live under $XDG_DATA_HOME/opencode-reader, else ~/.local/share/opencode-reader", () => {
  assert.equal(defaultDataDir({ XDG_DATA_HOME: "/data" }), "/data/opencode-reader")
  assert.equal(defaultDataDir({}), join(homedir(), ".local/share/opencode-reader"))
  assert.equal(defaultDataDir({ XDG_DATA_HOME: "relative/dir" }), join(homedir(), ".local/share/opencode-reader"))
  assert.equal(defaultCacheDir("/d"), "/d/books")
  assert.equal(defaultTokenFile("/d"), "/d/onyx-token")
  assert.equal(defaultSessionFile("/d"), "/d/onyx-sync-session")
  assert.equal(defaultBackupFile("/d"), "/d/onyx-backups.json")
})
