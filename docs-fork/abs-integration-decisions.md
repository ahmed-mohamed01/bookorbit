# ABS integration decisions

Living record of how the Audiobookshelf plugin talks to BookOrbit. Update it whenever an
integration point changes.

## The governing principle

> If BookOrbit already has a function or API that does what ABS needs, **call it** - do not
> reinvent it, and do not modify the code being called. If the API genuinely does not exist,
> adding one is acceptable. Either way the acid test is: **rip out the ABS plugin and BookOrbit
> must keep working normally.**

Corollaries:

- Hooks into upstream files must be minimal, `@Optional`, and have a working fallback.
- A change that alters BookOrbit's behaviour for users who do not have ABS installed is a bug,
  not a default.
- Merge surface is a secondary goal. Removability wins where they conflict. (We got this wrong
  once: audio-progress accessors were moved _into_ the ABS repository to shrink the diff, when
  calling the existing upstream API cost zero upstream lines and was more correct.)

## Feature scope (locked)

The owner listens to audiobooks in Audiobookshelf and wants that listening history to appear in
BookOrbit's Reading Log. That is the whole feature. Per matched book the sync payload is:

```
{ absItemId, identity, state, progressSeconds, percent, sessions[] }
```

| #   | Decision                                                                     | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Sessions are the deliverable**                                             | Session ingest, resumable backfill and daily-stat aggregation all stay. They feed the existing Reading Log: Total Time, Sessions, Avg Session, Progress journey, Activity heatmap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | **One-way, ABS -> BookOrbit**                                                | BookOrbit's web player is immature and unused for these books. No local writer to race. The bidirectional newest-wins guard collapses; only protection against overwriting a _user-set_ value survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Matching cascade stays, all tiers**                                        | Shared `metadata.json` raises the ASIN tier's hit rate, it does not remove the lower tiers - many ABS books have thin metadata. What is wrong is the _execution_ (N+1 query, full-inventory accumulation), not the logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | ~~**Book-level progress only**~~ **RETRACTED - the mapping is load-bearing** | Verified against the code: the audiobook resume path reads _only_ `(currentFileId, positionSeconds)` and never `percentage` (`AudiobookReaderView.vue:752-762`; `useAudioProgress.ts:33-36` does not even parse it). There is no percent -> (file, offset) resolver on any read path and no percent-edit UI. Writing `(firstFile, cumulativeSeconds)` opens the book at 00:00 of file 1 while the UI shows e.g. 73%; the next play flushes a corrected-downward percentage, and a drop >=10 points trips `strongRereadEvidence` (`book.service.ts:1947`), spuriously marking a reread. **Keep `resolveAbsPosition`** (~18 lines + one query) and the duration-mismatch guard. |
| 5   | **Two sync tiers, driven by a `mediaProgress` delta**                        | HOT: poll `GET /api/me` every tick and diff `mediaProgress` by `lastUpdate`. COLD: one-off resumable state + session ingest, checkpointed. Kills the scheduled full-inventory reconcile, staged pruning and deep-scan watermarks. Do **not** build on a "Continue Listening" endpoint: `mediaProgress` retains _finished_ entries, so a book finished between two polls is still observed - a dedicated in-progress endpoint would miss it.                                                                                                                                                                                                                                   |
| 6   | **Out of scope: finished in ABS with zero playback there**                   | Owner will perform "mark as read, read elsewhere" in BookOrbit, since BookOrbit is becoming the library manager and ABS is the listening app. This drops the third (sweep) tier and with it the unverifiable assumption that ABS creates a `mediaProgress` entry for a never-played item. Note the narrowness: finished _by listening_ in ABS still syncs normally.                                                                                                                                                                                                                                                                                                           |

**Progress accuracy is a hard requirement, not a nice-to-have.** The owner plans to later align
audiobook position with epub reading position (whisper `base.en`, 15s sample every 20min). Stored
progress must be accurate, not merely directionally right. Simplifications that remove unused
_capability_ are fine; ones that reduce progress _accuracy_ are not.

**Cadences as actually built (refines decision 5).** Three cadences run: (1) a **30s hot tier** that
fetches `/api/me` and applies position/status for only the _in-progress_ books
(`!isFinished && 0 < progress < 1`) - this gives near-live position for what the owner is currently
listening to; (2) the **15-min full poll** which applies the whole `mediaProgress` delta (including
newly-_finished_ books), ingests sessions, and reconciles if fresh; (3) the **one-off cold backfill**
of session history. The decision-5 caveat still holds and is not contradicted by the hot tier: we do
**not** depend on a "Continue Listening" _endpoint_ - the hot tier filters the full `mediaProgress`
payload client-side, and finishes are never missed because the 15-min full poll sees them (a
just-finished book is only _excluded from the hot tier_, so its finish is applied within <=15 min,
not lost). Trade-off: finish status can lag up to 15 min while position was live throughout.

## API decisions

| Need                                                            | Call this                                                                  | Do NOT                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Write audio playback position                                   | ABS repo `upsertAudioProgress` (bare write, **no** status)                 | `BookService.saveAudioProgress`                    |
| Import an external read (attempt)                               | `ReadingAttemptService.importExternalRead`                                 | hand-rolled attempt writes                         |
| Resolve the attempt for a session                               | attempt whose `started_on..ended_on` range contains the session            | `order by id desc`; KOReader's active-attempt rule |
| Derive read status from playback                                | ABS's own `resolveAbsTargetStatus` from ABS `isFinished`                   | `saveAudioProgress`'s percentage-derived status    |
| Accessible libraries for a user                                 | `LibraryService.findAccessibleLibraryIds(user)`                            | ad-hoc library queries                             |
| Apply a cover                                                   | `MetadataService.applyCoverFromSources`                                    | direct cover writes                                |
| Daily reading stats                                             | shared `aggregateReadingSessionDailyStats`                                 | bespoke aggregation                                |
| Outbound URL safety                                             | `ensureSafeUrl` from `common/utils/ssrf.utils`                             | a local scheme-only check                          |
| Insert reading sessions                                         | ABS repository (accepted)                                                  | -                                                  |
| ISBN parse for **persistence** (metadata.json -> book_metadata) | `metadata/lib/isbn-detect` (`normalizeIsbn` + `isValidIsbn10/13` checksum) | a bespoke length-only classifier                   |
| ISBN normalize for **matching** (lookup key)                    | hardcover's exported `normalizeIsbn` (the shared match helper)             | reinventing a second normalizer                    |

**Two ISBN paths, deliberately different.** The _persist_ path (`abs-metadata.mapper.ts`) validates
checksums via `isbn-detect` so a malformed ISBN is never written to `book_metadata`. The _match_
path (`audiobookshelf.repository.ts` ISBN tier) reuses hardcover's exported `normalizeIsbn` - the
same shared matching helper hardcover itself uses - and classifies the lookup key by length. No
checksum validation there is needed or wanted: the normalized forms are identical
(`[^0-9Xx]`/uppercase vs `[^0-9X]/gi`/uppercase produce the same string), stored ISBNs are already
validated on the persist side, and a malformed ABS ISBN can only fail to match - it can never match
a _wrong_ book. Using `isbn-detect` in the match path would fork a second normalizer from the shared
one, violating "call the existing function, don't reinvent."

**Why ABS must NOT route position writes through `saveAudioProgress` (corrected).** An earlier
version of this doc mandated `saveAudioProgress`. That was wrong: `saveAudioProgress`
unconditionally calls `autoUpdateReadStatusForProgress`, which derives status from **percentage vs
the library's `readingThreshold`/`markAsFinishedPercentComplete`**. ABS derives status from ABS's
authoritative `isFinished` flag in its own status branch (`resolveAbsTargetStatus`). Routing
position through `saveAudioProgress` fires a **second, percentage-based** status write on every
sync that clobbers the `isFinished`-based one - e.g. a book finished in ABS at 96% actual playback
with `markAsFinishedPercentComplete = 99` gets forced back to `reading`. So ABS keeps its own thin
`upsertAudioProgress` (a bare progress write with no status side-effect). This is deliberate, not
reinvention to eliminate. The read side (`findAudioProgress`) stays in the ABS repo too:
`getAudioProgress` would add a per-book `verifyBookAccess` inside the already-scoped sync loop for
no benefit. The access/file-ownership checks `saveAudioProgress` performs are instead the sync
scheduler's responsibility (it resolves a scoped `RequestUser` per user before the loop).

**Accepted deviation:** ABS inserts `reading_sessions` from its own repository. There is no
session-ingest service, and `koreader-plugin.repository.ts` sets the precedent. Acceptable - but
the attempt-resolution rule inside that insert must match KOReader's.

## Plugin boundary

"The plugin" = `server/src/modules/audiobookshelf/**`, `client/src/features/audiobookshelf/**`,
`packages/types/src/audiobookshelf.ts`, and the `AudiobookshelfModule` registration.

**Fork-owned but NOT plugin code** (must survive removal - other features depend on them):

| File                                      | Why it stays                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `common/utils/book-match.utils.ts`        | `hardcover-import.service.ts` imports it. Removing it breaks Hardcover.                             |
| `metadata/lib/cover-source-resolution.ts` | generic cover precedence resolution                                                                 |
| sidecar cover handler                     | contains nothing ABS-specific - stats a file, size-checks, decodes. Belongs in the metadata module. |

## Removal checklist

If the plugin is ripped out, these must also be cleaned up:

- `packages/types/src/index.ts` - drop the `./audiobookshelf` re-export (build fails otherwise)
- `client/src/features/settings/IntegrationAllSettings.vue` - drop the component import (matches
  how hardcover/readwise/storygraph are wired; same removal cost as any sibling)
- `client/src/features/settings/lib/integration-tabs.ts` - drop the tab entry
- `packages/types/src/permissions.ts` - `AudiobookshelfSync` becomes unused
- `client/src/locales/*.json` - the sidecar tooltip key becomes unused
- config: `AUDIOBOOKSHELF_ALLOW_LOCAL_SERVERS` becomes unread
- **database** - see the open decision below

## Open decisions

**1. Ownership of the `audiobookshelf` enum values in shared tables.** The bootstrap widens
`reading_attempts_origin_chk`, `reading_sessions_source_chk` and `reading_sessions.source`
(varchar 10 -> 20). None of it is reversible. After removal, rows with
`source = 'audiobookshelf'` remain while the TS union no longer contains that member, so
`SESSION_SOURCE_PILLS[session.source]` yields `undefined` and the reading-log UI errors on those
books. A later upstream migration that re-narrows the constraint would fail on those rows and
block startup.

There is no way for a plugin to add a value to an upstream CHECK constraint without either
modifying upstream or mutating a shared table. Options:
(a) propose the enum members upstream (cleanest, small ask, they are provider-agnostic),
(b) propose dropping the CHECKs in favour of app-level validation,
(c) keep the DDL and own a down-migration that rewrites orphan rows before re-narrowing.

**Status: resolved - pursuing (a).** This stopped being a tradeoff once scope decision 1 locked
sessions as the deliverable. The Reading Log's Source column renders
`SESSION_SOURCE_PILLS[session.source]`, so sessions _must_ land with `source = 'audiobookshelf'`
for the feature to work at all - the enum value is mandatory, not cosmetic. (a) is the only option
that leaves no orphan-row landmine when a future upstream migration re-narrows the constraint, and
the values are provider-agnostic: maintainers declining ABS _support_ is not the same as declining
a source value.

**2. Sidecar metadata precedence default.** Upstream ships
`['folderStructure', 'embedded', 'nfoFile', 'opfFile', 'sidecar']`; the fork promoted `sidecar`
to second position. That changes behaviour for users without ABS and survives removal, so it is
being reverted. If sidecar-first is wanted it belongs in per-library settings the user opts into.
**Status: reverting to upstream order.**

## Test debt

All 18 fork-owned ABS test files were removed during the correctness/removability refactor,
because they were written against the architecture being replaced. Upstream test files were kept
deliberately - they are the regression net proving BookOrbit still works.

To rewrite once the architecture settles, in priority order:

1. Reading-attempt integration, including the adopt-active-attempt case (H5) and session-to-attempt
   resolution across a re-read.
2. Position sync: the newest-wins guard must both block a locally-advanced write **and** recover on
   the next genuinely newer ABS update.
3. Matching: ASIN/ISBN normalization-insensitivity, ambiguity handling returning `null` rather than
   guessing.
4. Sessions ingest: pagination, resumable backfill checkpointing, idempotent re-ingest.
5. Schema bootstrap: idempotency and the constraint guards.
6. Cover refresh: precedence, fallback, `book_per_file` exclusion, locks, cancellation.
7. Client: settings tab, connection card token handling (never echoed back).
