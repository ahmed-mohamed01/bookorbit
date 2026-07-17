# Audiobookshelf client API contract

The client keeps all route paths in `api/audiobookshelf.api.ts` and imports Audiobookshelf request and response types from `@bookorbit/types`. Every route below is verified against the landed server implementation.

## Settings and connection

These routes are user-scoped and guarded at the controller by `Permission.AudiobookshelfSync`.

| Method   | Path                                     | Request body                                                                                                       | Expected response                 |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/settings`        | None                                                                                                               | `AudiobookshelfSettings`          |
| `PATCH`  | `/api/v1/audiobookshelf/settings`        | Changed fields from `{ serverUrl, apiToken, enabled, syncStatus, syncPosition, syncSessions, excludedLibraryIds }` | `AudiobookshelfSettings`          |
| `GET`    | `/api/v1/audiobookshelf/libraries`       | None                                                                                                               | `AudiobookshelfLibrariesResponse` |
| `DELETE` | `/api/v1/audiobookshelf/settings`        | None                                                                                                               | `200` with an empty body          |
| `POST`   | `/api/v1/audiobookshelf/test-connection` | Any subset of `{ serverUrl, apiToken }`. Omitted values use saved settings.                                        | `{ success, username?, error? }`  |

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
  lastSyncedAt: string | null
  lastSyncError: string | null
}
```

`AudiobookshelfLibrariesResponse` contains only ABS book libraries. Each entry has `{ id, name, mediaType, provider, excluded }`. All libraries are included when `excludedLibraryIds` is empty. Excluded libraries are omitted from matching and subsequent sync work.

The token is never returned to the browser. These routes and shapes are verified against server commit `985ae45d`.

## Linked books

| Method   | Path                                                                           | Request body                | Expected response                 |
| -------- | ------------------------------------------------------------------------------ | --------------------------- | --------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/books?bucket={bucket}&page={page}&pageSize={pageSize}` | None                        | `AudiobookshelfBookStatePage`     |
| `POST`   | `/api/v1/audiobookshelf/books/:absLibraryItemId/confirm`                       | None                        | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                          | `{ bookId: number }`        | Updated `AudiobookshelfBookState` |
| `DELETE` | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                          | None                        | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/exclusion`                     | `{ syncExcluded: boolean }` | Updated `AudiobookshelfBookState` |
| `POST`   | `/api/v1/audiobookshelf/books/rescan`                                          | None                        | `{ queued: number }`              |

`bucket` is one of `linked`, `needs-review`, or `unmatched`. Pagination is zero-based, so `page=0` is the first page. The client requests 20 rows per page and the server caps `pageSize` at 100. `queued` is the number of items that entered matching during a rescan.

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
  absCoverUrl: string | null
  bookId: number | null
  bookTitle: string | null
  bookAuthorName: string | null
  matchMethod: 'asin' | 'isbn' | 'title_author_series' | 'manual' | null
  matchConfidence: number | null
  needsReview: boolean
  matchError: string | null
  syncExcluded: boolean
  syncError: string | null
  lastSyncedAt: string | null
}
```

`absCoverUrl` is always `null` in v1 because authenticated cover proxying is deferred. The UI renders a local placeholder and never issues a broken image request for a null cover. Linked-book routes and shapes are verified against server commit `197df6c0`.

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
