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
  once: audio-progress accessors were moved *into* the ABS repository to shrink the diff, when
  calling the existing upstream API cost zero upstream lines and was more correct.)

## API decisions

| Need | Call this | Do NOT |
|---|---|---|
| Read audio playback position | `BookService.getAudioProgress(userId, bookId, user)` | ABS repo `findAudioProgress` |
| Write audio playback position | `BookService.saveAudioProgress(userId, bookId, dto, user)` | ABS repo `upsertAudioProgress` |
| Import an external read (attempt) | `ReadingAttemptService.importExternalRead` | hand-rolled attempt writes |
| Resolve the attempt for a session | the **active** attempt: `outcome is null and deleted_at is null` | `order by id desc limit 1` |
| Derive read status from playback | let `saveAudioProgress` drive `autoUpdateReadStatusForProgress` | `UserBookStatusService.updateManual` |
| Mark an explicit ABS "finished" | `UserBookStatusService.updateManual` (this case only) | - |
| Accessible libraries for a user | `LibraryService.findAccessibleLibraryIds(user)` | ad-hoc library queries |
| Verify access to a book | `BookService.verifyBookAccess` | unchecked reads |
| Apply a cover | `MetadataService.applyCoverFromSources` | direct cover writes |
| Daily reading stats | shared `aggregateReadingSessionDailyStats` | bespoke aggregation |
| Outbound URL safety | `ensureSafeUrl` from `common/utils/ssrf.utils` | a local scheme-only check |
| Insert reading sessions | ABS repository (accepted) | - |

**Why `saveAudioProgress` matters beyond tidiness.** It performs library access checks, verifies
the target file actually belongs to the book, computes re-listen evidence
(`strongRereadEvidence`), and applies the library's `readingThreshold` /
`markAsFinishedPercentComplete` via `autoUpdateReadStatusForProgress`. Bypassing it lost all four
and forced ABS to write playback-derived progress as a *manual* status, which then blocks later
auto-derivation.

**Known wrinkle:** `saveAudioProgress` returns `void`, but the newest-wins guard needs the written
row's `updatedAt`. Re-read via `getAudioProgress` after writing. Do **not** change the upstream
signature to return the row - that would modify code we are supposed to be calling.

**Accepted deviation:** ABS inserts `reading_sessions` from its own repository. There is no
session-ingest service, and `koreader-plugin.repository.ts` sets the precedent. Acceptable - but
the attempt-resolution rule inside that insert must match KOReader's.

## Plugin boundary

"The plugin" = `server/src/modules/audiobookshelf/**`, `client/src/features/audiobookshelf/**`,
`packages/types/src/audiobookshelf.ts`, and the `AudiobookshelfModule` registration.

**Fork-owned but NOT plugin code** (must survive removal - other features depend on them):

| File | Why it stays |
|---|---|
| `common/utils/book-match.utils.ts` | `hardcover-import.service.ts` imports it. Removing it breaks Hardcover. |
| `metadata/lib/cover-source-resolution.ts` | generic cover precedence resolution |
| sidecar cover handler | contains nothing ABS-specific - stats a file, size-checks, decodes. Belongs in the metadata module. |

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
**Status: undecided - owner's call.**

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
