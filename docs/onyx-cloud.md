# Onyx cloud protocol notes

What the plugin knows about the Onyx (BOOX) cloud, for contributors. None of
this is documented by Onyx: it was observed on one BOOX e-reader (NeoReader,
Android 13, firmware 4.2) and the send2boox web app, and may change at any
time. Placeholders: `<uid>` is the account's user id, `<docUniqueId>` a
library document's `uniqueId`, `<token>` the web app token.

The code lives in `src/onyx.ts` (HTTP client), `src/sync.ts` (documents and
decisions) and `src/neoposition.ts` (position strings).

## Endpoints

| Region | REST API | Sync Gateway |
| --- | --- | --- |
| EU (`"server": "eur"`) | `https://eur.boox.com/api/1/` | `https://eurcb.boox.com/neocloud/` |
| US (`"server": "us"`) | `https://push.boox.com/api/1/` | `https://cb.boox.com/neocloud/` |

A China gateway (`cb.send2boox.com`) exists; the plugin does not support it.

### Authentication

- The send2boox web app keeps a JWT in its Local Storage under `token`
  (valid about 6 months). Logging in by e-mail code needs a slider captcha,
  so the user pastes the token once.
- REST calls send `Authorization: Bearer <token>`.
- `GET {api}users/syncToken` returns
  `{ cookie_name: "SyncGatewaySession", session_id, expires, channels }`.
  The session lasts about 18 days. Gateway calls send
  `Cookie: <cookie_name>=<session_id>`.
- 401 (and 403 on the REST API) means the token was refused. The plugin
  caches the session with the gateway URL and a SHA-256 prefix of the token,
  and buys a new one when either changes or the session is about to expire.

### Library

The gateway is a Couchbase Sync Gateway. NeoReader's library sync (Library →
⋯ → Library Settings → Sync Switch) replicates to the channel
`<uid>-READER_LIBRARY`:

```text
GET {gateway}_changes?filter=sync_gateway/bychannel&channels=<uid>-READER_LIBRARY&include_docs=true
GET {gateway}<uid>%23<docUniqueId>          # one document (URL-encode the #)
```

Results flagged `deleted` or `removed`, and documents with `_deleted`, are
dropped.

## Documents

Library documents share the channel and differ by `modeType`:

| `modeType` | Kind | Useful fields |
| --- | --- | --- |
| 3 | Collection | `uniqueId`, `name`, `parentUniqueId` |
| 4 | Book | `_id = <uid>#<docUniqueId>`, `uniqueId`, `title`, `name` (file name), `type` (`"epub"`), `nativeAbsolutePath`, `size`, `fileOriginSize`, `progress`, `lastAccess`, `updatedAt`, `readingStatus`, `fileSyncStatus`, `extraAttributes` |
| 5 | Membership (book ↔ collection) | `documentUniqueId`, `libraryUniqueId` |
| 1 | Annotation | positions as below, with `textStartOffset`/`textEndOffset` |
| 7 | Note | |

- `status: 1` marks a removed document (seen on memberships and annotations;
  a re-added membership comes back as a new status-0 copy).
- `readingStatus`: 0 new, 1 reading, 2 finished (2 when `progress` current
  equals total).
- `progress` is `"current/total"` in the device's own page layout; `total`
  changes with the layout, so only the ratio is comparable across devices.
- `fileSyncStatus: 1` appears after "Upload source file" on the device. It is
  a hint only: the download is what counts.
- Not every book has a document, and some documents have no
  `extraAttributes` (no position: the plugin then reads the percentage only
  and never writes).

### `extraAttributes`

A JSON string. Its `backend` object holds:

- `current_page_position_v3`, `current_page_position_v2`, `current_page`:
  the reading position, each itself a string (below). Some documents have
  only `_v2`/`_v3`. The plugin reads v3, then v2, then `current_page`.
- `user_doc_data_update_time`: epoch ms of the last position save. On book
  open, NeoReader compares it with its last pull and, when the cloud is
  newer, shows a sync pop-up and jumps to the cloud position.
- `device_model`, `device_id`, `total_page`.

## Position string

```text
{"chapterIndex":0000000003,"nodePosition":0000001234,"textOffset":0000000017,"chapterStartPosition":0000045678,"chapterEndPosition":0000056789,"chapterID":"<manifestId>","xpath":[1,3,0,5,0]}
```

Numbers are zero-padded to 10 digits (arrays are not), so the string is not
strict JSON. Re-serialising with the same padding and key order gives the
same bytes.

| Field | Meaning |
| --- | --- |
| `chapterIndex` | Index of the `<itemref>` in the OPF spine |
| `chapterID` | Its `idref` (manifest id) |
| `chapterStartPosition`, `chapterEndPosition` | UTF-8 byte offsets of the chapter in the concatenation of the spine documents |
| `xpath` | Child-node indices from the document down to a text node, or to an element (then `textOffset` is 0). The XML declaration is not a node; whitespace text, the doctype and comments are, at every level |
| `nodePosition` | Index, in UTF-16 units, of that node in the chapter source |
| `textOffset` | Offset in the node's decoded text |

- An empty `xpath` with zero offsets is the chapter start.
- Annotations use `textStartOffset`/`textEndOffset`, and
  `startPositionInt = chapterStartPosition + nodePosition + textStartOffset`.
  Their `xpath` may be `null`.
- PDFs use `{"pageReferenceId":"pdf-N-M"}` (not handled).
- The plugin maps a position to its own `{ spine, character offset }` by
  aligning the chapter's text nodes with its paragraphs on non-space
  characters, by NFC cluster (robust to NFC/NFD, soft hyphens and zero-width
  characters). Lookup goes by `xpath`, then `nodePosition`, then a
  proportional fallback flagged `exact: false`.

## Writing a position

What the plugin does, and the only write it ever makes:

1. `GET` the book document (`modeType: 4`, `_id = <uid>#<docUniqueId>`) and
   keep its `_rev`.
2. Patch, by replacing byte spans of the `extraAttributes` string (a JSON
   round trip would turn `1633.0` into `1633`):
   - the three position strings (each keeping its own key order;
     `chapterStart/EndPosition` kept when the chapter is unchanged, else
     computed from the EPUB's byte sizes);
   - `backend.user_doc_data_update_time` = now;
   - `backend.device_model` = `"OpenCode"`.

   Then parse both strings and check that nothing else changed; any doubt
   refuses the write.
3. Set `progress` and `updatedAt`, drop `_cv`, leave every other field as is.
   `progress` is `total/total` only for a book finished in the reader;
   otherwise it is the percentage on `total`, clamped to `1..total-1`
   (`0/1` for an unfinished one-page book).
4. Save the document as it was to the local backup ring (last 20).
5. `PUT {gateway}<uid>%23<docUniqueId>` with the `_rev`. A 409 means the
   document changed meanwhile: retry once from step 1.

On the device, opening the book shows the sync pop-up; accepting it jumps to
the written position. Writing the position or `progress` over ADB does
nothing: NeoReader keeps its position in private app data and overwrites the
library row.

Own writes are recognised on the next read by `device_model == "OpenCode"`
together with the update time the plugin wrote.

## Book files (OSS)

After "Upload source file" on the device, the EPUB is stored in Aliyun OSS.

- `GET {api}config/buckets` lists the buckets; the file is in the
  `onyx-cloud` entry (`bucket`, `aliEndpoint`), also for EU accounts. The
  plugin only accepts an endpoint ending in `.aliyuncs.com`.
- `GET {api}config/stss` returns short-lived STS credentials
  (`AccessKeyId`, `AccessKeySecret`, `SecurityToken`, `Expiration`, about 15
  minutes). Keep them in memory only.
- Object key: `<uid>/reader/<docUniqueId>/book/<docUniqueId>.epub`.
- Request: `GET https://<bucket>.<aliEndpoint>/<key>` signed with OSS V1:

  ```text
  StringToSign  = "GET\n\n\n" + Date + "\n" + "x-oss-security-token:" + SecurityToken + "\n" + "/" + bucket + "/" + key
  Authorization = "OSS " + AccessKeyId + ":" + base64(HMAC-SHA1(AccessKeySecret, StringToSign))
  ```

  with the headers `Date` (RFC 1123, UTC), `x-oss-security-token` and
  `Authorization`.
- 404 or 403: no file (403 also drops the cached credentials). The plugin
  keeps a download only when its size equals `fileOriginSize` and the device
  file size and it starts with `PK`.
- Covers uploaded by the device sit under
  `<uid>/reader/<docUniqueId>/thumbnail/` in the same bucket.

## ADB (device side, read-only)

```sh
adb shell content query --uri content://com.onyx.content.database.ContentProvider/Metadata
```

One row per library item: `id`, `title` (may be `NULL`), `authors`, `name`,
`nativeAbsolutePath`, `size`, `lastAccess` (epoch ms, 0 when never opened),
`progress` (`current/total` or `NULL`), `updatedAt`, and `extraAttributes`
with the same `backend` positions as the cloud document (for books opened in
reflow mode). Rows include PDFs and other formats. `adb exec-out cat` exits 0
and prints errors on stdout, so a copy is accepted only when it is a ZIP of
the expected size.
