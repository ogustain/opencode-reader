# opencode-reader

An [OpenCode](https://opencode.ai) V2 plugin to read EPUB books in a session
panel while your agents work. Add your books, and it remembers each one's
position to the character.

- Add an EPUB file or a whole folder with `/add <path>`, or from "Add books…"
  in `/read` (you can drag the file into the terminal): it is moved into the
  reader's own library.
- Text-only reading, with contents, notes and display settings.
- Optional: keep your place in sync with a BOOX e-reader (stock NeoReader
  app) in both directions through the Onyx cloud, and open the books of your
  BOOX library. See [Optional: sync with a BOOX](#optional-sync-with-a-boox).

> The BOOX sync is **unofficial**: see [the note](#unofficial) and the
> [Disclaimer](#disclaimer).

## Requirements

- OpenCode V2 (the plugin uses the V2 plugin API and the session panel).
- EPUB files without DRM.
- For the BOOX sync only: see [its requirements](#requirements-for-the-boox).

## Install

```sh
opencode plugin add github:ogustain/opencode-reader
```

This installs the package and adds it to your global OpenCode config. To set
options, write the entry as an object in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ogustain/opencode-reader",
      "options": { "dir": "~/ebooks" }
    }
  ]
}
```

The panel and commands (the `./tui` export) load automatically beside the
server half. See [Configure plugins](https://opencode.ai/v2/docs/plugins).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dir` | `~/Books` | Extra folder of your own EPUBs, read if it exists (three levels deep); never created or changed |
| `dataDir` | `$XDG_DATA_HOME/opencode-reader`, else `~/.local/share/opencode-reader` | The reader's library (`library/`, where added books are moved), book cache, settings, Onyx token, sync session and push backups |
| `server` | the region chosen when connecting (`<dataDir>/settings.json`), else `"eur"` | Onyx account region: `"eur"` or `"us"`; when set, it wins over the one chosen |
| `tokenFile` | `<dataDir>/onyx-token` | File holding the Onyx token |
| `pushIdleMinutes` | `5` | Send the position after this many minutes without a page turn |
| `adb` | `adb` in `PATH`, then common install paths | Path of the `adb` binary |
| `serial` | none | Device serial when several Android devices are attached |

## Read

- `/read` (palette: "Reader: my books"): pick a book, most recent first,
  from the reader's library, from `dir` and from the books already fetched
  from the BOOX. It opens at your last position.
- `/add <path>` (palette: "Reader: add books"): adds that EPUB file or
  folder. `/add` alone, the palette command and **Add books…** (always first
  in `/read`) ask for the path: type it, or drag the file or folder into the
  terminal.
  - Books are **moved** into the reader's library, `<dataDir>/library`
    (by default `~/.local/share/opencode-reader/library`; folder 0700, files
    0600). A single book opens at once; a book already there opens its copy.
  - A folder adds its EPUBs three levels deep, at most 500 files at a time.
    Folders are never removed, even once emptied; refused files stay.
  - A toast sums up: "2 moved to the library · 1 already there · 1 refused
    (DRM)".
  - A book is added only if it opens as for reading: not an EPUB, protected
    (DRM), unreadable or over 512 MiB is refused.
  - The move is a copy first: the file is read once, the copy is checked,
    then published under a free name (`name (2).epub` when the name is
    taken; nothing is ever overwritten). Your file is removed only after
    that, and only if it is a regular file (not a symbolic link), unchanged
    since it was read, and the copy in the library has the same size and
    content. Otherwise it stays, and the toast says "copied; original kept"
    with the reason.
  - A book identical (same size and content) to one in the library or in
    `dir` is not copied again; its file is removed under the same checks:
    "already in the library (removed from Downloads)".
  - A file already in the library, `dir` or the BOOX cache is "already
    there" and never touched.
  - With no books yet, `/read` shows just "Add books…" (and "Connect a
    BOOX…"). You can also keep EPUB files in `dir` yourself: they are read
    in place.

Keys in the panel (click it to focus it):

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next page (`space` also turns forward) |
| `t` | Contents; picking a chapter jumps to its start |
| `n` | Notes referenced on this page (`↑` `↓` `←` `→` scroll, `n` `q` `Esc` back) |
| `s` | Display settings |
| `f` | Full screen |
| `q` `Esc` | Close the book |

The status line shows the percentage, chapter and page. The sidebar's
**Reading** section shows the open book and its percentage.

Turning a page forward (`→` or `Space`) onto the book's last screen, or
pressing it there, finishes the book: 100 %. Opening the book at its end or
resizing the panel never does; until then the percentage stops at 99 %. A
finished book leaves the sidebar section until you open an unfinished book.
Turning back a page goes below 100 % again.

Display settings (`s`, saved for all books): text width (80, 100 or 66
columns, or the full panel), paragraph spacing (blank line, or a first-line
indent), line spacing (normal or airy) and alignment (left or justified).
The font size follows your terminal.

Resizing the panel or changing a setting re-wraps the text but keeps the
first words of the screen on the top line: only a page turn or a jump moves
the position.

## Optional: sync with a BOOX

### Unofficial

> **Unofficial.** This project is not affiliated with, endorsed by or
> supported by Onyx International or BOOX. It talks to an undocumented,
> reverse-engineered API that may change or break at any time. Read the
> [Disclaimer](#disclaimer) before giving it your Onyx token.

With a BOOX, the plugin:

- Opens the books of your BOOX library (collections included).
- Picks up where the BOOX left off, and sends your OpenCode position back to
  the BOOX, on any network.
- Downloads a book file the BOOX uploaded to the Onyx cloud, or copies it
  over USB (ADB, read-only) when it is not in the cloud.

### Requirements for the BOOX

A BOOX e-reader using the stock NeoReader app, an Onyx (BOOX) account with
the library sync turned on, and optionally
[`adb`](https://developer.android.com/tools/adb) for USB copies.

### `/books`

- `/books` (palette: "Reader: BOOX library"): your BOOX collections as on the
  device (collection → sub-collection → book, plus "Not in a collection"),
  EPUB only, each book with its percentage and last read date. Finished books
  are hidden behind "Show finished books". `Esc` goes up one level.
  - Each book says where its file is: "on this computer" (already fetched), "in
    the cloud" (the BOOX was asked to upload it) or "Boox only".
  - Choosing a book opens the local copy; without one it downloads the file
    from the Onyx cloud, else copies it over ADB. With neither, it tells you
    to upload the file from the BOOX or plug the BOOX in.
  - "Download all unfinished books" fetches every unfinished book not yet
    here (cloud first, ADB for the rest) and reports how many it got.
  - Without an Onyx token, `/books` lists the device library over ADB. With
    no BOOX plugged in either, it offers "Connect a BOOX…", and "Use USB
    (ADB) instead" when `adb` is installed.

With the sync, the status line also shows **Sent to Boox** once your
position reached the cloud. When the cloud cannot carry it, it shows **Boox:
go to 47 %** instead (in the sidebar too): use NeoReader's "go to" to jump
there. A finished book is sent to the BOOX as finished (its progress becomes
the last page, its position stays on that screen), and `/books` hides it.

### Connect a BOOX

"Connect a BOOX…" is in `/read` (until a BOOX is connected), in `/books`
when no BOOX is found, and in the palette ("Reader: connect a BOOX"):

1. Choose your account's server: Europe ([eur.boox.com](https://eur.boox.com))
   or US ([push.boox.com](https://push.boox.com), also for other regions).
   The `server` option, when set, wins over this choice.
2. Follow the steps shown to copy your token:
   - On the BOOX: Library → ⋯ → Library Settings → turn on **Sync Switch**.
     To keep a book out of the sync: long-press it → **Sync** tab.
   - Log in to the Onyx web app of your server with the BOOX account. Open
     the browser developer tools → Application → Local Storage → the site,
     and copy the value of `token`.
3. Paste the token. The prompt shows it as you type, so paste it when no one
   is looking at your screen.

The plugin checks the token with the Onyx cloud first. A refused token is
never saved; an accepted one is saved to `tokenFile` (0600, replaced in one
step) with the region in `<dataDir>/settings.json`, and `/books` opens. No
restart is needed.

"Reader: disconnect the BOOX" (palette, once connected) deletes the token
file and the sync session, after a confirmation. Your positions, the cached
books, the backups and the sync records stay.

### Manual token (alternative)

Instead of the guided flow, you can save the token yourself:

1. Turn on the library sync and copy the token as in steps 1 and 2 above
   (EU accounts use [eur.boox.com](https://eur.boox.com); US accounts use
   [push.boox.com](https://push.boox.com) and the option `"server": "us"`).
2. Save it in a file only you can read. Type it at a hidden prompt rather
   than on a command line, which would end up in your shell history:

   ```sh
   mkdir -p -m 700 ~/.local/share/opencode-reader
   read -rs "TOKEN?Onyx token: "; echo        # zsh; bash: read -rsp "Onyx token: " TOKEN; echo
   (umask 077; printf '%s' "$TOKEN" > ~/.local/share/opencode-reader/onyx-token); unset TOKEN
   chmod 600 ~/.local/share/opencode-reader/onyx-token
   ```

   Use `$XDG_DATA_HOME/opencode-reader` or your `dataDir` instead if you set
   one. The `chmod` also covers a file that already existed. The plugin makes
   the token, session and backup files private (0600) whenever it finds them
   readable by others, and refuses them when they are symbolic links (it
   never replaces a token file that is a symbolic link either). Quotes copied
   with the value are ignored.

When the token expires (after about 6 months) the plugin says "Onyx token
expired: paste a new one (see README)": connect again ("Reader: connect a
BOOX"), or repeat the manual steps. Without a token or a network, the plugin
falls back to ADB quietly.

### Book files in the cloud

To read a book without the cable, make its file downloadable once: on the
BOOX, long-press the book in the library → **Upload source file**. `/books`
then shows it "in the cloud".

- Downloads go to `<dataDir>/books/`, the same cache as ADB copies.
- A download is kept only if its size matches the BOOX file and it is a ZIP.
  Files over 512 MiB are refused; a download gives up after 10 minutes.
- Storage access uses short-lived credentials (about 15 minutes) obtained
  with the token and kept in memory only. Only GET requests reach the storage.
- A file missing from the cloud, a refusal or no network falls through to
  ADB.

### ADB (optional)

ADB is only needed for books that are not in the cloud, and for `/books`
without a token.

1. On the BOOX: Apps → ☰ → App Management → enable **USB Debug Mode**.
2. Install the Android platform tools (macOS: `brew install --cask
   android-platform-tools`; Linux: your distribution's `adb` package).
3. Plug the BOOX in, accept "Allow USB debugging", and check that
   `adb devices` lists it as `device`.
4. Optional, without the cable (same Wi-Fi, after one USB session):
   `adb tcpip 5555`, unplug, then `adb connect <boox-ip>:5555`.

The BOOX must be awake and unlocked for ADB to answer.

### How sync works

Sync applies to books opened through `/books` (added books and books from
`dir` are not matched with the BOOX library).

- **Automatic when certain, asked otherwise.** If only the BOOX read since
  the last agreement, opening the book or the panel jumps to its position;
  if only you read here, closing the panel, switching books or
  `pushIdleMinutes` idle send yours. Read on both sides (or here before any sync):
  opening the book asks which to keep, or later; meanwhile the panel says
  "Read on both sides — open the book to choose". Opening a book on the BOOX
  is not reading; clocks are never compared. Failed sends retry once at the
  next start. On the BOOX, **accept the sync pop-up** to jump there.

Protocol details for contributors are in
[docs/onyx-cloud.md](docs/onyx-cloud.md).

## Limits

- NeoReader saves its position when the book is closed: close the book (or go
  back to the library) on the BOOX before reading here.
- Without the cloud, percentages are approximate: the BOOX counts pages of its
  own layout, the plugin counts characters.
- Books whose cloud record has no reading position yet (never opened on the
  BOOX since the sync was turned on) are not sent; the "go to N %" hint is
  shown instead.
- EPUB only, without DRM (Adobe ADEPT or encrypted chapters are refused;
  obfuscated fonts are fine). ZIP64 archives are not supported. Documents
  must be UTF-8 or UTF-16; other encodings are refused.
- Text only: images, tables and styling are dropped. Wide (CJK) characters
  may overflow the panel width and are not justified correctly.
- Tested with NeoReader on one BOOX model (Android 13). Other models and
  firmware versions may store positions differently.

## Disclaimer

- Not affiliated with Onyx International or BOOX. "BOOX", "Onyx" and
  "NeoReader" are their owners' trademarks.
- The Onyx cloud API used here is unofficial and was reverse-engineered. It
  may change, break or be rate-limited without notice. Use at your own risk.
- **The Onyx token grants full access to your Onyx account.** Keep the token
  file private (0600), never commit or share it. The plugin never logs,
  displays or sends it anywhere but the Onyx servers.
- **What is written to your account:** only book records of your library,
  and in them only the reading position fields (the three position strings,
  `progress`, the update time, `device_model: "OpenCode"` and `updatedAt`).
  Before each write, the record as it was is saved to
  `<dataDir>/onyx-backups.json` (the last 20, file mode 0600), and the
  write itself is noted in `<dataDir>/onyx-sync.json` (to recognise it
  later), with the last agreed reading per book.
- **What is never written:** collections, memberships, annotations, notes,
  files in the cloud storage, and anything on the device. Nothing is ever
  deleted. ADB is read-only: it lists the library and copies book files,
  nothing more.

## Privacy

No telemetry, no analytics, no third-party service. Your books, positions
and settings stay on your machine, in OpenCode's plugin storage and in
`dataDir`. The only network traffic goes to your own Onyx account (the API,
the sync gateway and its file storage), and only when a token is set.

## Development

```sh
npm install
npm run build:tui     # src/tui.tsx → dist/tui.js
npm run typecheck
npm test              # node --experimental-strip-types --test
```

These need Node 22.6 or later (checked on 22.23 and 24.18). `npm install`
warns `EBADENGINE` because `@opentui/core` asks for Node 26.4: it is only
installed for its types, so the warning is harmless.

Run `npm run build:tui` after editing `src/tui.tsx` and commit `dist/tui.js`: an
installed package gets no Solid JSX transform, so it loads the compiled file
(a test fails when it is stale). Don't name the script `build`: npm then
prepares git installs by running a full `npm install`, which fails.

- `src/index.ts`, the server half: owns files, the device and the network,
  so it also works with a remote OpenCode server.
- `src/tui.tsx`: picker, panel, sidebar and keys, compiled to `dist/tui.js`.
- `src/epub.ts` (ZIP on `node:zlib`, OPF, table of contents), `src/text.ts`
  (XHTML → paragraphs, note references and texts), `src/paginate.ts` (wrapping, pages, position ↔ %),
  `src/adb.ts`, `src/library.ts` (also adds books), `src/input.ts` (typed
  paths and tokens), `src/onyx.ts` (cloud client, connect and disconnect),
  `src/sources.ts` (cloud then ADB), `src/neoposition.ts` (NeoReader
  positions), `src/sync.ts` (collection tree, pull/push decisions).

No runtime dependency besides `@opencode/plugin`. Tests use synthetic data
only: never add real books, tokens or account ids to the repository.

## License

[MIT](LICENSE)
