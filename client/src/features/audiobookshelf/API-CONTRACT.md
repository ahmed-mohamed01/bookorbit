# Audiobookshelf client API contract

The client keeps all route paths and request and response types in `api/audiobookshelf.api.ts`. The server reconciliation pass should update that file if a controller differs from this contract.

## Settings and connection

| Method   | Path                                              | Request body                                                                             | Expected response                   |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/settings`                 | None                                                                                     | `AudiobookshelfSettingsResponse`    |
| `PATCH`  | `/api/v1/audiobookshelf/settings`                 | Any subset of `{ serverUrl, apiToken, enabled, syncStatus, syncPosition, syncSessions }` | `AudiobookshelfSettingsResponse`    |
| `DELETE` | `/api/v1/audiobookshelf/settings`                 | None                                                                                     | Empty success response              |
| `POST`   | `/api/v1/audiobookshelf/settings/test-connection` | Any subset of `{ serverUrl, apiToken }`. Omitted values use saved settings.              | `{ valid, serverName?, username? }` |

`AudiobookshelfSettingsResponse`:

```ts
{
  serverUrl: string | null
  tokenConfigured: boolean
  enabled: boolean
  syncStatus: boolean
  syncPosition: boolean
  syncSessions: boolean
  lastSyncedAt: string | null
  lastSyncError: string | null
}
```

The token is never returned to the browser.

## Linked books

| Method   | Path                                                                           | Request body                | Expected response                 |
| -------- | ------------------------------------------------------------------------------ | --------------------------- | --------------------------------- |
| `GET`    | `/api/v1/audiobookshelf/books?bucket={bucket}&page={page}&pageSize={pageSize}` | None                        | `AudiobookshelfBookStatePage`     |
| `POST`   | `/api/v1/audiobookshelf/books/:absLibraryItemId/confirm`                       | None                        | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                          | `{ bookId: number }`        | Updated `AudiobookshelfBookState` |
| `DELETE` | `/api/v1/audiobookshelf/books/:absLibraryItemId/link`                          | None                        | Updated `AudiobookshelfBookState` |
| `PATCH`  | `/api/v1/audiobookshelf/books/:absLibraryItemId/exclusion`                     | `{ syncExcluded: boolean }` | Updated `AudiobookshelfBookState` |
| `POST`   | `/api/v1/audiobookshelf/books/rescan`                                          | None                        | `{ queued: number }`              |

`bucket` is one of `linked`, `needs-review`, or `unmatched`. The client requests 20 rows per page and never requests an unbounded collection.

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

Both requests remain open until the run completes. The client provides indeterminate in-flight feedback and disables both actions while a request is active.

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

## Assumptions

- Server ticket 02 will add `Permission.AudiobookshelfSync` with the confirmed literal value `audiobookshelf_sync`. Until that shared-types change is merged, the settings tab uses the literal cast to `Permission` and does not modify `packages/types`.
- Settings updates use `PATCH`, matching the Hardcover and StoryGraph integrations and allowing connection fields and sync toggles to be saved independently.
- Connection tests accept omitted URL or token fields and use the stored value for anything omitted. This lets a configured user test without exposing or re-entering the saved token.
- Manual sync and full resync are synchronous HTTP operations that return the summary above. No status or stream endpoints were specified by tickets 04 or 06.
- Linked-book actions identify rows by the URL-encoded ABS library item id because it is stable and unique per user.
- Rescan completes the matching pass before returning. The client reloads all three bounded first pages after it succeeds.
