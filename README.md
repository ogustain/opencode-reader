# opencode-reader

An [OpenCode](https://opencode.ai) V2 plugin to read EPUB books in a session
panel while your agents work, and to keep your place in sync with a BOOX
e-reader (stock NeoReader app) in both directions through the Onyx cloud.

- Opens EPUBs from a local folder, or from your BOOX library (collections
  included), and remembers each book's position to the character.
- Picks up where the BOOX left off, and sends your OpenCode position back to
  the BOOX, on any network.
- Downloads a book file the BOOX uploaded to the Onyx cloud, or copies it
  over USB (ADB, read-only) when it is not in the cloud.
- Works without a BOOX too: it is then a plain EPUB reader.

> **Unofficial.** This project is not affiliated with, endorsed by or
> supported by Onyx International or BOOX. It talks to an undocumented,
> reverse-engineered API that may change or break at any time. Read the
> [Disclaimer](#disclaimer) before giving it your Onyx token.

## Requirements

- OpenCode V2 (the plugin uses the V2 plugin API and the session panel).
- For the BOOX features: a BOOX e-reader using the stock NeoReader app, an
  Onyx (BOOX) account with the library sync turned on, and optionally
  [`adb`](https://developer.android.com/tools/adb) for USB copies.
- EPUB files without DRM.

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
      "options": { "dir": "~/ebooks", "server": "us" }
    }
  ]
}
```

The panel and commands (the `./tui` export) load automatically beside the
server half. See [Configure plugins](https://opencode.ai/v2/docs/plugins).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dir` | `~/Books` | Folder of local EPUB files, searched three levels deep |
| `dataDir` | `$XDG_DATA_HOME/opencode-reader`, else `~/.local/share/opencode-reader` | Book cache, Onyx token, sync session and push backups |
| `server` | `"eur"` | Onyx account region: `"eur"` or `"us"` |
| `tokenFile` | `<dataDir>/onyx-token` | File holding the Onyx token |
| `pushIdleMinutes` | `5` | Send the position after this many minutes without a page turn |
| `adb` | `adb` in `PATH`, then common install paths | Path of the `adb` binary |
| `serial` | none | Device serial when several Android devices are attached |

## Use

- `/read` (palette: "Reader: read a book"): pick a book, most recent first,
  from `dir` and from the books already fetched from the BOOX. It opens at
  your last position.
- `/books` (palette: "Reader: Boox library"): your BOOX collections as on the
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
  - Without an Onyx token, `/books` lists the device library over ADB.

Keys in the panel (click it to focus it):

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next page (`space` also turns forward) |
| `t` | Contents; picking a chapter jumps to its start |
| `s` | Display settings |
| `f` | Full screen |
| `q` `Esc` | Close the book |

The status line shows the percentage, chapter and page, and **Sent to Boox**
once your position reached the cloud. When the cloud cannot carry it, it
shows **Boox: go to 47 %** instead: use NeoReader's "go to" to jump there.
The sidebar's **Reading** section shows the open book and its percentage.

Turning a page forward (`→` or `Space`) onto the book's last screen, or
pressing it there, finishes the book: 100 %. Opening the book at its end or
resizing the panel never does; until then the percentage stops at 99 %. A
finished book is sent to the BOOX as finished (its progress becomes the last
page, its position stays on that screen), `/books` hides it, and the sidebar
section goes away until you open an unfinished book. Turning back a page goes
below 100 % again.

Display settings (`s`, saved for all books): text width (80, 100 or 66
columns, or the full panel), paragraph spacing (blank line, or a first-line
indent), line spacing (normal or airy) and alignment (left or justified).
The font size follows your terminal.

Resizing the panel or changing a setting re-wraps the text but keeps the
first words of the screen on the top line: only a page turn or a jump moves
the position.

## BOOX and Onyx setup

### Library sync and token

1. On the BOOX: Library → ⋯ → Library Settings → turn on **Sync Switch**.
   To keep a book out of the sync: long-press it → **Sync** tab.
2. Log in to the Onyx web app ([eur.boox.com](https://eur.boox.com) for EU
   accounts; US accounts use the US site and the option `"server": "us"`).
   Open the browser developer tools → Application → Local Storage → the site,
   and copy the value of `token`.
3. Save it in a file only you can read. Type it at a hidden prompt rather
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
   readable by others, and refuses them when they are symbolic links. Quotes
   copied with the value are ignored.

When the token expires (after about 6 months) the plugin says "Onyx token
expired: paste a new one (see README)": repeat steps 2 and 3. Without a
token or a network, the plugin falls back to ADB quietly.

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

## How sync works

Sync applies to books opened through `/books` (books from `dir` are not
matched with the BOOX library).

- **BOOX → OpenCode.** Opening a book, and opening the panel, read the book's
  cloud record (never on a timer; opening the panel at most once a minute per
  book, opening a book every time). When the
  BOOX saved or opened the book after your last page turn here, the book
  jumps to the BOOX position, to the character, and a toast says so.
- **OpenCode → BOOX.** Closing the panel, switching books, or
  `pushIdleMinutes` without a page turn send the position, but only when your
  last page turn here is newer than the BOOX's last save and the position
  changed. A send that failed or was cut short (OpenCode quit meanwhile) is
  tried again once at the next start or panel opening. On the BOOX, open the
  book and **accept the sync pop-up**: NeoReader jumps to the OpenCode
  position.
- **Who is newer.** The plugin remembers the cloud record's revision at each
  read and write. If the record has not changed since (or holds the
  plugin's own write), any page turned here since wins, whatever the BOOX's
  clock says. If the BOOX saved since **and** you turned pages here too, it
  is a real conflict: the most recent of the two times wins (BOOX clock
  against this computer's clock).

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
  write itself is noted in `<dataDir>/onyx-sync.json` (to recognise it later).
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
  (XHTML → paragraphs), `src/paginate.ts` (wrapping, pages, position ↔ %),
  `src/adb.ts`, `src/library.ts`, `src/onyx.ts` (cloud client),
  `src/sources.ts` (cloud then ADB), `src/neoposition.ts` (NeoReader
  positions), `src/sync.ts` (collection tree, pull/push decisions).

No runtime dependency besides `@opencode/plugin`. Tests use synthetic data
only: never add real books, tokens or account ids to the repository.

## License

[MIT](LICENSE)
