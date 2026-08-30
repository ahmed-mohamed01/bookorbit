# Audiobookshelf client API contract

The client keeps all route paths in `api/audiobookshelf.api.ts` and imports Audiobookshelf request and response types from `@bookorbit/types`. Every route below is verified against the landed server implementation.

## Settings and connection

These routes are user-scoped and guarded at the controller by `Permission.AudiobookshelfSync`.

| Method   | Path                                           | Request body                                                                                                                     | Expected response                  |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/settings`              | None                                                                                                                             | `AudiobookshelfSettings`           |
| `PATCH`  | `/api/v1/audiobookshelf/settings`              | Changed fields from `{ serverUrl, apiToken, enabled, syncStatus, syncPosition, syncSessions, excludedLibraryIds, pathMappings }` | `AudiobookshelfSettings`           |
| `GET`    | `/api/v1/audiobookshelf/libraries`             | None                                                                                                                             | `AudiobookshelfLibrariesResponse`  |
| `DELETE` | `/api/v1/audiobookshelf/settings`              | None                                                                                                                             | `200` with an empty body           |
| `POST`   | `/api/v1/audiobookshelf/test-connection`       | Any subset of `{ serverUrl, apiToken }`. Omitted values use saved settings.                                                      | `{ success, username?, error? }`   |
| `POST`   | `/api/v1/audiobookshelf/path-mappings/suggest` | None                                                                                                                             | `AudiobookshelfMappingSuggestions` |

`AudiobookshelfSettings`, imported from `@bookorbit/types`:

```ts
{
  serverUrl: string | null
  tokenConfigured: boolean
  enabled: boolean
  effectiveEnabled: boolean
  disabledReason: 'permission_denied' | 'missing_config' | 'user_disabled' | null
  syncStatus: boolean
  syncPosition: boolean
  syncSessions: boolean
  excludedLibraryIds: string[]
  pathMappings: { absPrefix: string; localPrefix: string }[]
  lastSyncedAt: string | null
  lastSyncError: string | null
  staleCount: number
}
```

`staleCount` is the number of stale entries a cleanup (with `includeManuallyUnlinked: true`) could remove, counted during the last successful full inventory walk (a reconcile or a cleanup): rows whose Audiobookshelf item was gone and that carry no link and no exclusion, including manually unlinked rows, since the point of the count is to surface every row a cleanup control can still clear. It is `0` until such a walk runs, is never written by a partial, hot-tier or failed run, and after a successful cleanup it is set to what a repeat cleanup with `includeManuallyUnlinked: true` would still find, which is `0` only when that cleanup also removed the manually unlinked rows it saw. The sync status strip renders it next to the last-run line together with the inline `Clean up` action whenever it is above zero.

`pathMappings` rewrites an Audiobookshelf absolute path prefix to the BookOrbit one for the same storage, which lets matching link items by folder. The server accepts at most 20 rows; both prefixes are required, trimmed, and capped at 500 characters, and are stored canonicalized (duplicate separators collapsed, trailing separator dropped, repeated ABS prefixes dropped). The mapping editor lives on the sync options card and is saved with the rest of the sync options (`Save sync options`), not with the connection card. Saving a mapping set that differs from the stored one (order-insensitively) also clears the negative-match memo on the user's unmatched rows, so the next scheduled sync re-attempts them under the new mappings without an explicit rescan.

`AudiobookshelfMappingSuggestions`:

```ts
{
  suggestions: AudiobookshelfPathMappingSuggestion[]
  scannedItems: number
}
```

`AudiobookshelfPathMappingSuggestion` is an `AudiobookshelfPathMapping` (`absPrefix`, `localPrefix`) plus a `supportCount`. The suggest route infers mappings instead of asking the user to type them: it walks the selected Audiobookshelf libraries fresh, keys every item by its last two path segments (author/book, identical on both servers), and looks up the same key among the user's accessible BookOrbit book folders. An item whose key names exactly one local folder votes for the prefix pair the two paths differ by; a key that names several local folders abstains. Pairs need at least 5 agreeing items, are returned highest-support first, capped at 10, and already-saved pairs are excluded (compared canonicalized). `scannedItems` counts every item the walk saw, including ones without a path. Like the cleanup this is all-or-nothing: a failed page fetch returns `503`, an empty inventory `400`, and a concurrent inventory walk (another suggest, a cleanup, or a rescan) `409`, which the client maps to `An Audiobookshelf inventory walk is already running`. Nothing is saved server-side: the client appends the suggestions as ordinary mapping rows (skipping duplicates, respecting the 20-row cap) and the user persists them with `Save sync options`.

`AudiobookshelfLibrariesResponse`:

```ts
{
  libraries: { id: string; name: string; mediaType: string; folderPaths: string[] }[]
  localFolderPaths: string[]
}
```

`libraries` contains only ABS book libraries. All libraries are included when `excludedLibraryIds` is empty. Excluded libraries are omitted from matching and subsequent sync work.

`folderPaths` are the library's root folders on the Audiobookshelf server (`folders[].fullPath`), and `localFolderPaths` are the distinct root folders of the BookOrbit libraries this user can access, sorted and capped at 500. Both feed the folder-mapping pick-lists on the sync options card: the ABS side offers the folders of the libraries still selected for sync, the local side offers `localFolderPaths`. Both inputs stay free text so a subfolder can be typed. `localFolderPaths` is scoped by the same accessible-library rule as the linked-books routes, so it never exposes a library the user cannot see.

The token is never returned to the browser. These routes and shapes are verified against the landed server implementation in `server/src/modules/audiobookshelf/`.

## Linked books

| Method   | Path                                                                                     | Request body                                     | Expected response                 |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/books?bucket={bucket}&page={page}&pageSize={pageSize}&q={query}` | None                                             | `AudiobookshelfBookStatePage`     |
| `POST`   | `/api/v1/audiobookshelf/books/:absLibraryItemId/confirm`                                 | None                                             | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                                    | `{ bookId: number }`                             | Updated `AudiobookshelfBookState` |
| `DELETE` | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                                    | None                                             | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/exclusion`                               | `{ syncExcluded: boolean }`                      | Updated `AudiobookshelfBookState` |
| `POST`   | `/api/v1/audiobookshelf/books/rescan`                                                    | None                                             | `{ queued: number }`              |
| `POST`   | `/api/v1/audiobookshelf/books/cleanup-stale`                                             | Optional `{ includeManuallyUnlinked?: boolean }` | `AudiobookshelfCleanupResult`     |

`bucket` is one of `linked`, `needs-review`, or `unmatched`. Pagination is zero-based, so `page=0` is the first page. The client requests 20 rows per page and the server caps `pageSize` at 100. `q` is optional free text matching either the Audiobookshelf title or the matched BookOrbit title; the client debounces it 300ms and resets every bucket to page 0 on change. `queued` is the number of items that entered matching during a rescan.

Rows from an ABS library currently deselected for sync are omitted from all three buckets and from sync work. They are not deleted: re-selecting the library restores them with their links and decisions intact. A row remembers which ABS library it came from once a reconcile has walked that library; a row created before this behavior carries no library tag until then, so a legacy row from a deselected library keeps showing up until one re-select, Rescan, deselect cycle tags it (an unlinked one can also be removed sooner with Clean up).

The client applies confirm/link/unlink/exclusion updates locally from the response (moving the item between bucket arrays and adjusting totals) instead of reloading all three buckets, since the response already carries the fields (`bookId`, `needsReview`, `matchError`) that determine bucket membership. A rescan still triggers a full reload since `{ queued: number }` isn't enough to update locally.

`AudiobookshelfBookStatePage`:

```ts
{
  items: AudiobookshelfBookState[]
  total: number
  page: number
  pageSize: number
}
```

`AudiobookshelfBookState`:

```ts
{
  absLibraryItemId: string
  absTitle: string
  absAuthorName: string | null
  absSeriesName: string | null
  absLibraryName: string | null
  absPath: string | null
  bookId: number | null
  bookTitle: string | null
  bookAuthorName: string | null
  bookSeriesName: string | null
  bookLibraryName: string | null
  bookFolderPath: string | null
  matchMethod: 'asin' | 'isbn' | 'path' | 'title_author_series' | 'manual' | null
  matchConfidence: number | null
  needsReview: boolean
  matchError: string | null
  syncExcluded: boolean
  syncError: string | null
  lastSyncedAt: string | null
}
```

`absSeriesName`, `absLibraryName`, and `absPath` describe the Audiobookshelf side of a candidate (its series, the ABS library it lives in, and its item path); `bookSeriesName`, `bookLibraryName`, and `bookFolderPath` describe the matched BookOrbit book the same way. The review card shows library and path on both sides so a user can tell which physical item a candidate points at before confirming or rejecting it. The `book*` fields are `null` until the row has a linked `bookId`. The `abs*` fields are ABS facts, not user decisions: they are refreshed from the live Audiobookshelf inventory on every reconcile (sync, rescan, or scheduled match), so a renamed series or a moved library folder on the ABS side shows up on the next reconcile rather than staying stale.

`AudiobookshelfCleanupResult`:

```ts
{
  removed: number
  staleLinked: number
  staleExcluded: number
  staleManuallyUnlinked: number
  seenItems: number
}
```

Cleanup is explicit and never automatic: matching itself never prunes, so an empty or failed inventory can never wipe state. The server walks the selected libraries fresh and aborts without deleting anything if any page fetch fails (`503`) or if the walk sees zero items (`400`). A page the server reports as short while its `total` says more items remain is treated the same as a failed walk (`503`), since trusting a truncated page would make the cleanup delete every item it never got to see. Only rows with no linked book, no exclusion, and (unless opted in) no manual unlink, whose item was not seen, are deleted; stale rows that still carry a link or an exclusion are returned as `staleLinked` / `staleExcluded` and kept. A manually unlinked row is a deliberate user decision, not an accident to clean up automatically, so it is returned as `staleManuallyUnlinked` and kept by default; setting `includeManuallyUnlinked: true` in the request body removes those rows too. `staleCount` (on `AudiobookshelfSettings`) counts manually unlinked rows regardless of this flag, so the stale-count indicator and its `Clean up` action stay visible for a library whose only stale rows are manual unlinks. A concurrent request receives `409 Conflict`, which the client maps to `An Audiobookshelf cleanup is already running`. The client arms the button on the first click, runs on the second, and afterwards reloads all three buckets (removals can span them) plus the settings, since a successful cleanup resets `staleCount` to whatever a repeat cleanup with `includeManuallyUnlinked: true` would still find.

A rescan (`force`) also re-tests pending review proposals. A unique ASIN, ISBN, or path hit replaces the proposal (`matchMethod` becomes that tier, `matchConfidence` 100, `needsReview` false) even when it names a different book, because a published identity outranks a similarity score. An ambiguous hit clears the link and stores the ambiguity as `matchError`. With no exact hit the row falls through to the fuzzy tier alongside the fresh items, so a proposal that no longer scores is replaced or cleared rather than left standing. Manual links and already-confirmed matches are never re-tested. A rescan also acquires the same inventory-walk guard as cleanup and suggest, so a rescan started while either of those (or another rescan) is already running for the user receives `409 Conflict` with the same `An Audiobookshelf inventory walk is already running` message.

`path` means the item was linked because its mapped folder equals a BookOrbit book folder or content file path. Like `asin` and `isbn` it is an auto-link with `matchConfidence` 100 and `needsReview` false, but the UI renders it as an identity ("Path match") with no percentage.

Every match tier (ASIN, ISBN, path, title/author/series) only considers BookOrbit books that have at least one audio content file, the same rule `isAudioFormat` uses for the sync itself. An ebook-only book is never a candidate at any tier, and a rescan clears any earlier proposal that pointed at one instead of leaving it standing. This is intentional: an Audiobookshelf item can only ever play an audio file, so matching it to an ebook-only book would be a match no sync could ever act on, and scoring ebook-only candidates on every reconcile would be pointless work at library scale.

There is no cover URL: authenticated Audiobookshelf cover proxying would require echoing the ABS token to the client, which this fork does not do. The UI always renders a local placeholder icon instead. Linked-book routes and shapes are verified against server commit `197df6c0`.

## Book picker

| Method | Path                                      | Request body | Expected response    |
| ------ | ----------------------------------------- | ------------ | -------------------- |
| `GET`  | `/api/v1/books/search?q={query}&limit=10` | None         | `BookSearchOption[]` |

This existing, permission-scoped BookOrbit route returns bounded candidates with `{ id, title, authors, seriesName, libraryName, formats }`.

## Sync

| Method | Path                                 | Request body | Expected response          |
| ------ | ------------------------------------ | ------------ | -------------------------- |
| `POST` | `/api/v1/audiobookshelf/sync`        | None         | `AudiobookshelfSyncResult` |
| `POST` | `/api/v1/audiobookshelf/full-resync` | None         | `AudiobookshelfSyncResult` |

Both requests remain open until the run completes. The client provides indeterminate in-flight feedback and disables both actions while a request is active. A concurrent request receives `409 Conflict`, which the client maps to `An Audiobookshelf sync is already running`.

`AudiobookshelfSyncResult`:

```ts
{
  matched: number
  statusApplied: number
  positionApplied: number
  sessionsApplied: number
  skipped: number
  failed: number
}
```

`matched` is the number of newly auto-linked items during this run. Sync route behavior and response shape are verified against server commits `a3a4ac37` and `2f64e109`.

## Assumptions

None.
