# Fork Maintenance

This is a **personal downstream fork** of BookOrbit. Upstream maintainers have
declined Audiobookshelf support, so this fork carries it as a permanent overlay:

- **Audiobookshelf metadata.json / cover.jpg sidecar support**
- **Audiobookshelf reading-progress + position sync**

We track `upstream/main` and merge its releases indefinitely. We do **not** follow
upstream's submission requirements (no squash-for-PR, no upstream commit
conventions). The single design goal is: **minimize the merge-conflict surface so
each upstream merge is a short chore, not a project.**

## Guiding principle

1. **Keep feature code in feature files.** ABS logic belongs in the `audiobookshelf`
   module, the ABS client feature dir, and ABS-owned schema. New fork-only files cost
   nothing at merge time - they can never conflict.
2. **Hooks into upstream files are allowed.** A small, generic extension point (a DI
   token, a registry, a spread) in an upstream file is an acceptable and expected cost.
   The aim is a _minimal_ footprint, not a zero footprint.
3. **A hook must shrink the footprint, not grow it.** This is the rule that decides
   whether a seam is worth building. Measure before and after: if the seam machinery
   adds more lines to the upstream file than the ABS code it removes, it is a net loss -
   reject it, even if it is well written and the tests pass. (See "Investigated and
   rejected" below; this exact trap was hit once and reverted.)
4. **Prefer generic over ABS-specific.** When a hook does stay in an upstream file,
   it should contain **no ABS identifiers** - upstream could plausibly have written it.
   Generic code survives upstream refactors far better than `sidecar`-flavoured code.
5. **Accept the irreducible.** Progress sync _is_ an edit to reading-state code. Some
   coupling cannot be designed away; keep it surgical and commented.
6. **Never depend on a data invariant upstream does not maintain.** If a fork feature needs
   data in a particular shape, enforce it at **read time** - never by repairing rows that
   upstream code keeps writing in the other shape. A repair pass over a column you do not
   own is a loop you can never win: you control neither the writers nor when they run.

## Reviewing changes: scope, dead code, and upstream reuse

These rules apply to every review - pre-commit on a fork feature, and again during each upstream
merge. Start by fixing the baseline: `git diff -w upstream/main`. Every finding is scoped to that
diff - the code this fork adds or changes.

1. **Dead / redundant / non-functional code is a finding only when it is _ours_.** Upstream's own
   dead code, awkward code, or latent bugs are **out of scope**: do not flag them and never "fix"
   them. We do not maintain upstream's internals, and touching an upstream file to tidy it only grows
   the conflict surface - the opposite of the goal. Leave upstream files byte-identical to upstream
   unless a hook genuinely earns its place (see "Guiding principle").

2. **Fork code that duplicates upstream behaviour is redundant - delete it and call upstream.** If a
   helper, method, or branch we added reproduces something upstream already does, and the behaviour is
   **identical**, remove ours and route callers to the upstream function. Reinventing read-status
   updates, progress/percent-read writes, percentage math, library-access checks, or book lookups that
   upstream already exports is the canonical form of this finding.

3. **This rule is strongest at merge time.** A merge is where the fork should get _smaller_, not
   merely survive. When an upstream merge introduces - or newly exposes - a function that does what a
   fork-added helper does, delete the fork helper and point its callers at upstream, provided the
   behaviour is identical. Over successive merges this is how the fork surface shrinks instead of
   drifting.

4. **"Identical" is a high bar - judge behaviour, not signature.** Same inputs -> same outputs, same
   side effects, same error and edge-case handling. If upstream's version differs subtly (different
   rounding, different newest-wins / precedence semantics, or it swallows an error we deliberately
   propagate - cf. the `audio.extractor.ts` try/catch removal under "Investigated and rejected") a raw
   call is wrong.
   But "not identical" does **not** mean "reinvent." First ask whether a **thin wrapper** - the
   upstream call plus a small adapter for the difference - is _more maintainable than a standalone fork
   implementation_. If it is, wrap upstream: the bulk of the logic stays on upstream's side and the
   fork surface shrinks (this is the same footprint test as a seam - the wrapper must be smaller than
   what it replaces). Only when even a wrapper is more code, or more fragile, than owning it outright
   do you keep a fully separate fork implementation - and then comment _why_ it diverges, so the next
   reviewer does not "deduplicate" it back into a regression.

5. **Deliberate code-moves are not duplication.** Extracting upstream code verbatim into a fork-only
   file for reuse (e.g. `fuzzy-match.utils.ts`) is the sanctioned way to share upstream logic without
   inverting layering - do not flag it as duplication, but honour its merge hazard note.

6. **Plugin isolation is a review gate, not a nicety.** A fork feature must be removable: with its
   module unregistered the full upstream app still builds and runs, and every upstream hook degrades
   to a no-op. A change that makes upstream depend on fork code fails review regardless of correctness.

**Stance.** Reviewers assume nothing is correct because tests pass or because it already merged. The
bar is: robust, performant, and compliant with both the **feature objective** and these
**fork-maintenance objectives**. Prefer several independent, adversarial reviews over one - they
disagree in the useful places - then synthesise into a single ranked verdict.

## Enforce fork invariants at read time (worked example)

ABS matching needs a canonical ASIN to look books up by. `book_metadata.audible_id` is an
**upstream-owned** column: upstream's audio extractor stores the raw `asin` tag verbatim, about
eight upstream write paths populate it, and none normalize. That is not an upstream bug - upstream
never queries or indexes the column, so it never needed a canonical form. The fork introduced that
requirement.

The first attempt normalized at the fork's own two boundaries and then ran a boot-time
`UPDATE book_metadata SET audible_id = upper(trim(audible_id))` repair pass. That was wrong twice
over: it re-scanned the table on every application start forever (the predicate is non-sargable, so
no index helps and the "already clean" case is the expensive one), and it could never actually hold
the invariant, because every new scan of an audiobook with a lowercase ASIN tag re-introduced
unnormalized rows.

The fix was to stop repairing data and make the **comparison** normalization-insensitive -
`upper(trim(audible_id))` matched against already-normalized inputs, backed by a functional index on
the same expression. That needs no cooperation from any other write path, is correct regardless of
who wrote the row or when, and deleted the boot-time scan entirely.

Generalise it: when a fork feature wants to match on an upstream column, normalize in the query and
index the expression. Do not try to impose an invariant on data you do not own.

## Measuring the surface: use `-w`, always

Raw diff line counts are **misleading** and will send you chasing phantom work. A fork
change that unwraps a `try/catch` reindents the whole block, so the raw diff explodes
while the semantic change is tiny.

```
# raw (misleading)
git diff      --numstat upstream/main -- <file>
# semantic (what actually conflicts)
git diff -w   --numstat upstream/main -- <file>
```

Real example: `audio.extractor.ts` shows **188 raw** lines but **26 semantic** - ~99%
was reindentation. It was ranked a top-3 seam target on the raw number and turned out
to need no work at all.

## Branch model

- **`monitored` is this fork's main branch.** It carries all three overlays (Audiobookshelf,
  reading alignment, monitored) on top of upstream. `audiobookshelf-support` and
  `reading-alignment` are the historical branches it absorbed; do not develop on them.
  Local `main` is a plain mirror of `upstream/main` with no fork commits.
- **Merge upstream, never rebase.** Merging preserves fork history and keeps conflict
  resolution incremental.
- **Merge frequently and small.** A 15-commit gap is what made one merge painful.
  Merge per upstream release (or weekly); small merges = trivial conflicts.

## The merge ritual

```
git fetch upstream
git merge --no-commit --no-ff upstream/main   # resolve per the audit below
pnpm install                                  # upstream bumps deps most cycles
pnpm -w run verify:fast                       # lint + typecheck, both workspaces (the pre-push gate)
(cd server && npx vitest run)                 # full server suite: ABS, alignment, monitored included
(cd client && npx vitest run)                 # full client suite
(cd server && pnpm db:migrate)                # apply the cycle's upstream migrations to the dev DB
git commit -F <message>                       # one signed merge commit
```

Before `db:migrate`, confirm the dev ledger holds no fork hashes
(`select left(hash,12) from drizzle.__drizzle_migrations order by created_at desc`); a
fork hash newer than the incoming upstream migrations would make Drizzle skip them silently
(see "Schema decoupling").

While resolving conflicts, apply **"Reviewing changes"** above: if the incoming upstream code now does,
identically, what a fork-added helper does, replace the fork helper with a call to upstream rather than
re-resolving around it. The merge is the moment to shrink the fork, not just re-carry it.

**Migrations no longer need any merge step.** `server/src/db/migrations/` is
byte-identical to upstream (see "Schema decoupling"), so upstream migrations flow in
untouched and `_journal.json` can no longer collide.

Known pre-existing upstream failures (**not** caused by the fork): the
`published-date.utils` timezone bug, which also fails `kobo.scraper.test.ts`. Don't
chase these during a merge.

Fork-caused spec drift, which **is** ours to fix at merge time: upstream specs that count
the permission catalog (`UserFormDrawer.spec.ts` expects one more than upstream because of
`audiobookshelf_sync`) and fork spec fixtures that hand-build upstream types
(`MonitoredBookPanel.spec.ts` builds a `ReleaseCandidateItem`; a new required upstream field
breaks it). Each is a one-line catch-up; make it rather than carry a red test.

### Merge log

- **2026-09-26, upstream v3.1.0 + 12 (`0b2df6e3`), 27 commits.** 18 conflicted files. Upstream added
  an `android` reading-session source (unioned beside `audiobookshelf` in every enum, bucket and `IN`
  list; the ABS bootstrap's constraint list and `LIKE` guard now name `android`) and **separate ebook
  and audiobook cover slots** (`book_covers`, `BookCoverStore`, `CoverSlotReconciler`). The fork's
  sidecar cover now saves through upstream's store: `applyCoverSource` picks the slot with upstream's
  `chooseSidecarMedium`, checks that medium's lock (`cover` / `audioCover`) and saves with origin
  `opf`, **not** `folder_image`, because the reconciler re-resolves folder-image slots from embedded
  art on every file change and would undo sidecar precedence. `ensureThumbnailForBook` left
  `metadata.service.ts` with upstream (moved into the cover store). The ABS bulk cover refresher went
  from a stale copy to a wrapper around upstream (see "Investigated and rejected"). The library cover
  refresh keeps upstream's `refreshBookCovers` and only takes the sidecar read order for books with a
  sidecar. **Migration 0096 recreated `reading_sessions_source_chk` again**; row parking handled it
  (223 rows parked, restored byte-identical on the next boot - note a dev server already running
  boots before `db:migrate` finishes, so it needs one more restart to restore). Fork spec drift:
  `coverMedia` / `covers` / `coverVersion` in the `LinkBookControl` and `ReadingAlignmentControl`
  fixtures, the `EXTRA_PROGRESS_SOURCE` card mock (file query now ends in `orderBy`), and the
  provider-seam scanner test, whose positional constructor args had shifted onto upstream's new
  `coverStore` / `coverReconciler` slots and was passing vacuously. Semantic surface:
  `metadata.service.ts` 134 -> 140, `scanner.service.ts` 287 -> 288. Verified: `verify:fast` green,
  server 16,676 and client 7,712 tests green, dev DB migrated through 0098.
- **2026-09-22, upstream v3.0.0 + 5 (`970b1525`), 29 commits.** 29 conflicted files, all additive
  unions except the reader open path. Upstream added read-aloud / media-overlay playback,
  podcasts, a books/podcasts media mode, iOS and watchOS session sources, Prowlarr and SABnzbd,
  and a duplicates ledger. The merge shrank four hooks: upstream's single-query
  `countDistinctSources` reduced `achievement.repository.ts` to `'audiobookshelf'` in two `IN`
  lists (22 -> 4) and deleted `hasAudiobookshelfSession`; upstream shipped
  `StatsCache.clearForScopePrefix` (an item from the propose-upstream queue), so
  `dashboard-widget.service.ts` dropped its per-user scope tracking (36 -> 19); upstream's
  options-object `open()` let cross-format resume become one `crossFormatResume` field
  (`useFoliate.ts` 37 -> 15, `ReaderView.vue` 38 -> 29). `book.repository.ts` kept upstream's
  three-batch card hydration and fetches the extra progress source after it, so the pool bound
  upstream introduced still holds. The Monitored sidebar entry gained `modes: ['books']`.
  Fork spec drift caught up: `readAloudSync` in the `LinkBookControl` and
  `ReadingAlignmentControl` fixtures. **Migration 0091 recreated `reading_sessions_source_chk`**,
  the hazard "Schema decoupling" predicted; see the row-parking rule there. Migrations 0091 to
  0095 flowed in untouched. Verified: `verify:fast` green, server 15,896 and client 7,327 tests
  green, dev DB migrated with 223 ABS sessions parked and restored byte-identical.
- **2026-09-16, upstream v2.10.0 (`b10bb58a`), 14 commits.** Four conflicts. Upstream moved
  audio progress out of `book.service.ts` into a new `audiobook` module whose
  `putPlaybackState` does not emit `book:progress-changed`, so the fork's emit (needed by the
  alignment sync and the live-refreshing detail tabs) relocated into
  `audiobook/audiobook.service.ts` as an `@Optional()` `AchievementEventsService` injection
  plus one guarded emit, and `AudiobookModule` imports `AchievementModule`. Net effect:
  `book.service.ts` fell from 19 to 10 semantic lines and `audiobook.service.ts` gained 12.
  `ssrf.utils.ts` took upstream's `RemoteHostResolutionException` beside the fork's
  `blockLinkLocal` branch. Migrations 0088 to 0090 flowed in untouched (directory still
  byte-identical to upstream). Upstream's `audiobook_progress` rows now carry `revision`,
  `captured_at`, `operation_id` and `manifest_revision`; both fork writers now honour them
  (see "Current conflict surface").
- **2026-09-16, post-merge review pass** (three independent per-overlay reviews, then four
  implementation agents on disjoint files). Shrunk the surface from 1852 to 1607 semantic
  lines: monitored settings left `app-settings/*` for a monitored-owned table (95 -> 0),
  the orphan-author delete and a dead lookup left `authors.repository.ts` (73 -> 38), the
  quick-monitor bell moved into `useMonitorGroupAction()` (75 -> 20), the edition-link card
  merge went behind `EXTRA_PROGRESS_SOURCE` (61 -> 29), the Goodreads header-stack copy
  became a call to upstream's `fetchHtml`, and the detail tabs adopted upstream's
  `useBookProgressRefresh`. Correctness fixes found by the same reviews: ABS and alignment
  writes bump `audiobook_progress.revision`, alignment play order mirrors upstream's
  manifest comparator, the `.local` bypass of `blockLinkLocal` is closed, usenet releases in
  the monitored picker use upstream's `delivery` field, `release-window.ts` rejects
  impossible calendar dates, and the Audible bibliography mapper uses upstream's date and
  series normalizers.

## Schema decoupling (done)

ABS schema is **not** a Drizzle migration. It is applied at runtime by
`AudiobookshelfSchemaBootstrapService` (`OnApplicationBootstrap`) from SQL embedded in
`modules/audiobookshelf/schema/audiobookshelf-schema.ts`.

- Idempotent: `CREATE TABLE IF NOT EXISTS`, plus `pg_constraint` / `information_schema`
  guards so a large `reading_sessions` is **never** revalidated on reboot (verified: a
  second boot is a ~6ms no-op with the constraint OID unchanged).
- ABS tables are invisible to drizzle-kit (not reachable from `db/schema/index.ts`), so
  `db:generate` reports "No schema changes".
- The SQL is embedded in TypeScript, not shipped as a `.sql` asset - the SWC watch
  builder does not reliably copy assets, and a missing file made the whole app fail to
  boot. Embedding also let `nest-cli.json` revert to upstream.
- Consequence: ABS tables use `db.select()`, **not** Drizzle's `db.query.<table>`
  relational API (which only knows tables in the schema barrel).

**Rules that keep the database switchable between this fork and the upstream image.**
Prod must survive a switch to the upstream container and a later return to the fork.
Every fork feature with schema (ABS, edition links, reading alignment, monitored) follows
these; the pattern is a deliberate fork exception to the CLAUDE.md rule "never hand-write
migration SQL", which exists for upstream contributions - fork schema never goes upstream.

- Never add files under `server/src/db/migrations/`. Fork schema is bootstrap SQL only, so
  the Drizzle ledger holds upstream hashes only. Drizzle applies every journal entry newer
  than the ledger's latest timestamp, so one fork migration in the ledger makes the
  upstream image silently skip any upstream migration generated before it.
- Fork tables live in `modules/<feature>/schema/` and are never exported from
  `db/schema/index.ts`.
- A fork column on an upstream table must be nullable, added with
  `ADD COLUMN IF NOT EXISTS` by the module that reads it, and read or written through a
  module-local `pgTable` declared for the same table name - never by editing the upstream
  schema file. Example: `book_requests.auto_grab` is owned by the book-request module
  (`modules/book-request/schema/book-request-auto-grab.schema.ts` plus its bootstrap, which
  runs in `onModuleInit` so the column exists before that module's crons tick).
- A database that ever applied a fork migration must have those ledger rows removed, or
  both images will skip upstream migrations older than them. Between 2026-09-04 and
  2026-09-06 the `monitored` branch shipped migrations 0086 to 0090; on any database that
  ran it (dev and test instances only, never prod), run once:
  `delete from drizzle.__drizzle_migrations where left(hash, 12) in ('960f1671810e',
'550a44aa480d', '8b83e5f0ee7b', '20c8ec37ddf6', 'c5c3e317e464');`
- Do not modify upstream CHECK constraints. The `audiobookshelf` value in
  `reading_sessions_source_chk` and `reading_attempts_origin_chk` is the one accepted
  exception. An upstream migration that recreates either constraint validates every row and
  would fail on those values, rolling the whole migration run back.
  - `reading_sessions.source` is handled automatically (it happened in v3.0.0, migration 0091).
    `scripts/check-constraint-row-parking.ts` runs from `migrate.ts` beside upstream's own
    pre-migrate compatibility steps: when a **pending** migration names the constraint, it records
    the affected row ids in `fork_parked_check_rows` and nulls the value (the column is nullable,
    NULL passes a CHECK, and NULL buckets as BookOrbit). The ABS bootstrap re-extends the
    constraint and then restores the labels and drains the table. If the database moves to the
    upstream image instead, the rows simply stay NULL until the fork returns.
  - When upstream adds a session source, add it to the bootstrap's constraint list **and** to its
    `LIKE` guard in `audiobookshelf-schema.ts`, or the bootstrap would re-extend with a stale list.
  - `reading_attempts.origin` is `NOT NULL`, so it cannot be parked this way. If upstream ever
    recreates `reading_attempts_origin_chk`, relabel those rows to a placeholder by hand, migrate,
    boot the fork, then restore them; extend the parking script only if it recurs.
- Bootstrap services log only when they create something or fail. A no-op boot is silent.

**Switching images on prod (fork to upstream and back)**

- `pg_dump -Fc` before any switch. That dump is the rollback.
- Upstream ignores fork tables and nullable fork columns, so switching to the upstream
  image loses nothing; fork features simply disappear from the UI until you return.
- Before returning to the fork, merge it forward to at least the upstream version that
  last ran against the database. Never run older code against a newer schema.

## Landed seams - the pattern to copy

Both live in upstream files, contain **zero ABS identifiers**, and are supplied from
`modules/audiobookshelf/` through the `@Global` `AudiobookshelfMetadataModule`:

| Seam                 | Upstream file                             | Token                         |
| -------------------- | ----------------------------------------- | ----------------------------- |
| Format extractors    | `metadata/metadata-extraction.service.ts` | `EXTRA_METADATA_EXTRACTORS`   |
| Cover sources        | `metadata/cover-source-handler.ts`        | `EXTRA_COVER_SOURCE_HANDLERS` |
| Metadata sources     | `scanner/metadata-source-provider.ts`     | `EXTRA_METADATA_SOURCES`      |
| Bulk cover refresher | `book/bulk-cover-refresher.ts`            | `BULK_COVER_REFRESHER`        |
| Card progress source | `book/extra-progress-source.ts`           | `EXTRA_PROGRESS_SOURCE`       |

The token files themselves are fork-authored new files (zero conflict). `EXTRA_PROGRESS_SOURCE`
is supplied from `edition-link/` (a `@Global` module that imports nothing, so it can never form a
cycle) and lets `book.repository.ts` merge a counterpart's progress into card progress without
naming any fork table; with the module unregistered it is a no-op. The residual coupling the
seams could not remove lives in `scanner.service.ts` and `metadata.service.ts` and is tallied
below.

## Current conflict surface (semantic, `-w`)

> **2026-09-24: the table below predates the Storyteller read-along overlay.** That overlay adds
> **38 semantic lines across 6 upstream files**, added up file by file: `router/index.ts` (+8),
> `settings-nav.ts` (+10), `integration-tabs.ts` (+6/-1), `app.module.ts` (+2),
> `packages/types/src/index.ts` (+1) and `server/.env.example` (+10, the Storyteller env-var block).
> Everything else it adds is fork-only, including the whole
> `modules/storyteller/` tree, `features/storyteller/`, the three new `common/utils/` helpers, and
> `AudiobookshelfPathMappings.vue` (+1/-1, an import path fix after `PathPrefixCombobox.vue` moved to
> `components/ui/` to be shared by both integrations) - it lives in the fork-only `audiobookshelf`
> feature directory, so it never touches the upstream conflict surface even though it changed.
> `modules/audiobookshelf/` is itself fork-only, so moving its URL and SSRF guard into
> `common/utils/self-hosted-service-url.utils.ts` costs no upstream conflict surface at all.

Measured 2026-09-22, after the upstream v3.0.0 merge (`970b1525`). Source files only (locales,
tests and docs excluded); per-file numbers are added+removed with `-w`. **80 modified upstream
source files, 1614 semantic lines.** The v3.0.0 merge removed about 68 lines of hooks; the total
is level with 2026-09-16 (1607) only because the per-format release-date work that landed in
between added about 75 lines to the Hardcover client. Fork-authored new files never conflict and
are excluded.

| File                                                                                                     | Semantic          | Owner         | Status                                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------- | ------------- | --------------------------------------------------------------------------- |
| `scanner/scanner.service.ts`                                                                             | 287               | ABS           | Phase B (fork-internal shrink only; see rejected list)                      |
| `metadata/metadata.service.ts`                                                                           | 134               | ABS           | cover/sidecar precedence, no ABS identifiers                                |
| `metadata-fetch/providers/hardcover/hardcover.client.ts` + `.types.ts`                                   | 168 / 114         | monitored     | author search, contributions, per-format editions; reuse `BOOK_FIELDS`      |
| `user-book-status/reading-attempt.service.ts` / `.repository.ts`                                         | 61 / 37           | ABS           | irreducible core (origin-based dedupe, soft-delete aware)                   |
| `book-request/book-request.repository.ts` / `.service.ts` / dto                                          | 47 / 18 / 8       | monitored     | `auto_grab` column, research filter, create passthrough                     |
| `reader/epub/epub.service.ts`                                                                            | 43                | alignment     | `extractSpineText` seam                                                     |
| client `settings/LibrariesSettings.vue` / `LibraryRowActions.vue`                                        | 39 / 10           | ABS           | re-extract metadata library action                                          |
| `authors/authors.repository.ts`                                                                          | 38                | monitored     | name lookup/create + portrait candidates (was 73)                           |
| client `reader/ReaderView.vue` / `epub/composables/useFoliate.ts`                                        | 29 / 15           | alignment     | resume ladder via the `crossFormatResume` open option (was 38 / 37)         |
| `dashboard/dashboard-widget.service.ts`                                                                  | 19                | ABS           | **generic, propose upstream** (status-change listener; was 36)              |
| client `author/views/AuthorsView.vue` / `AuthorTile.vue` / `AuthorIndexRow.vue`                          | 35 / 25 / 25      | monitored     | monitor action via `useMonitorAuthorAction()`                               |
| `.github/workflows/container-image.yml`                                                                  | 32                | fork          | deliberate: any-branch manual builds + stable branch-name image tag         |
| `book/book.repository.ts`                                                                                | 27                | alignment     | `EXTRA_PROGRESS_SOURCE` seam + N-way newest-wins merge (was 61)             |
| client `router/index.ts` / `useSidebarNav.ts` / `settings-nav.ts` / `AppSidebar.vue`                     | 28 / 21 / 19 / 12 | mixed         | route, nav and badge registration (ABS + monitored)                         |
| `achievement/achievement.repository.ts`                                                                  | 4                 | ABS           | `'audiobookshelf'` in upstream's two source `IN` lists (was 22)             |
| `common/utils/ssrf.utils.ts`                                                                             | 21                | ABS           | generic `blockLinkLocal` option (exported helper) - **propose upstream**    |
| client `book-requests/components/RequestSearchPanel.vue`                                                 | 20                | monitored     | quick-monitor bell via `useMonitorGroupAction()` (was 75)                   |
| `.env.example` / `Dockerfile` / `config/config.ts`                                                       | 17 / 15 / 6       | alignment     | whisper stage + alignment config, additive                                  |
| `audiobook/audiobook.service.ts` / `.module.ts`                                                          | 14 / 3            | ABS+alignment | `book:progress-changed` emit from `putPlaybackState` - **propose upstream** |
| `book-request/fulfillment/request-automation.service.ts` / `indexers/indexer-search.service.ts` / module | 13 / 11 / 4       | monitored     | `grabAllowed`, `IndexerSearchRequest` Pick, exports                         |
| client `book/.../tabs/ReadingLogTab.vue` / `DetailsTab.vue`                                              | 13 / 10           | alignment     | control insertions + upstream's `useBookProgressRefresh` (pure additions)   |
| `metadata/metadata-extraction.service.ts`                                                                | 12                | ABS           | the extractor seam itself                                                   |
| client `useLibraryCreator.ts`                                                                            | 12                | ABS           | UI registration                                                             |
| `metadata/lib/cover.ts`                                                                                  | 11                | ABS           | shared helper (`isDecodableImage`)                                          |
| `book/book.service.ts` / `book.controller.ts`                                                            | 10 / 8            | ABS           | progress emit for file progress; `BULK_COVER_REFRESHER` seam (was 19)       |
| `authors/authors.module.ts` / `author-enrichment-executor.service.ts`                                    | 9 / 8             | monitored     | export + `allowOrphan` flag                                                 |
| `app.module.ts`                                                                                          | 8                 | all           | module registration                                                         |
| `scripts/migrate.ts`                                                                                     | 2                 | ABS           | pre-migrate row parking call (generic name, no ABS identifiers)             |
| `scanner/scanner.controller.ts` / `scanner.repository.ts`                                                | 7 / 2             | ABS           | re-extract endpoint                                                         |
| `achievement-events.service.ts` / `koreader.service.ts`                                                  | 6 / 3             | ABS+alignment | `occurredAt` widening - **propose upstream**                                |
| `metadata-fetch.module.ts` / `providers/goodreads/goodreads.provider.ts`                                 | 2 / 2             | monitored     | `GoodreadsProvider` exported, `fetchHtml` made public (was a copy)          |
| `scanner/lib/classify.ts`                                                                                | 1                 | ABS           | `metadata.json` sidecar recognition (was 6)                                 |
| everything else                                                                                          | <= 6 each         | mixed         | enum members, `Record<Union>` exhaustiveness, trivial registrations         |
| `client/src/locales/*.json`                                                                              | ~60 each          | all           | i18n keys, trivial conflicts                                                |

Zeroed on 2026-09-16: `app-settings/app-settings.service.ts` (62 -> 0), `app-settings.controller.ts`
(17 -> 0), `common/constants/app-settings.constants.ts` (16 -> 0) and `seed/seed.service.ts`
(2 -> 0) - monitored settings moved into a monitored-owned table; `metadata-fetch/providers/goodreads/*`
header-stack copy replaced by a call to upstream's now-public `fetchHtml`. Earlier zeroings (v2.7.0):
`hardcover/hardcover-import.service.ts`, `metadata/extractors/audio.extractor.ts`, client
`LibraryCreatorMetadata.vue`.

**`ReadingLogTab.vue` / `DetailsTab.vue` live refresh (adopted from upstream).** Both tabs call
upstream's `useBookProgressRefresh()` (the same `book:progress-changed` subscription, debounced
250 ms), so the reading-log and details tabs live-update for **every** progress source. The fork's
earlier inline subscription filtered by `bookId`; upstream's callback carries no payload, so that
guard is gone and a burst of any book's progress costs one refetch of the open tab. Proposing that
upstream pass the event to the callback would restore the guard for free.

One backend line travels with it: the ABS sync emits `book:progress-changed` with `source:
'audiobookshelf'`, which required adding `'audiobookshelf'` to the `BookProgressChangedEvent.source`
union (`packages/types/src/scanner.ts`) and its server twin (`achievement-events.service.ts`). This is
the **same enum-widening pattern** already carried for `reading_sessions.source` /
`reading_attempts.origin` (commit `be8bd0e0`): a provider naming itself in a shared enum, additive and
removable (drop the plugin and the member is simply unused). It belongs on the same **propose-upstream**
list as those enum members - the alternative, reusing a false `web_reader`/`koreader` literal, would
write dishonest source data.

**ABS never writes `reading_attempts.external_provider`/`external_id`.** That slot is upstream
Hardcover's link target (`hardcover.repository.ts` `linkReadingAttempt` only stamps an attempt whose
slot is empty or already Hardcover's, else reports a conflict), and an earlier version of ABS sync
stamped it too, so every ABS-touched book permanently failed Hardcover sync with `read_link_conflict`.
ABS provenance is `origin: 'audiobookshelf'` alone; `ReadingAttemptService.importUnlinkedRead` dedupes
finished imports by origin plus finish date, checking soft-deleted rows too so a user-deleted import
stays deleted instead of resurrecting on the next sync. The schema-bootstrap overlay in
`audiobookshelf-schema.ts` runs an idempotent `UPDATE` on every boot to clear any legacy stamps left
by the old behaviour.

**`audiobook_progress` is shared with upstream's web player (since v2.10.0).** The row carries
`revision` (optimistic concurrency: the player sends `baseRevision` and reloads on 409),
`captured_at`, `operation_id` and `manifest_revision`. Both fork writers honour it: ABS
(`upsertAudioProgressGuarded`) uses `revision` as its compare-and-set base, bumps it, and stamps
`captured_at` from the ABS media-progress time; the alignment projection
(`projectAudiobookProgress`) keeps its newest-wins `updatedAt` guard but also bumps `revision` and
stamps `captured_at`. Neither touches `operation_id` or `manifest_revision`. Do not route either
writer through `AudiobookService.putPlaybackState`: it derives read status from percentage (ABS
decides on "finished" instead) and has no freshness guard (the projection needs one).

**`dashboard-widget.service.ts` live-cache invalidation (generic, not ABS-coupled).** The
"Currently Reading" header is served from a 120s `liveCache`, while the scrollers
(`dashboard.service.ts`, e.g. Continue Listening) are uncached. So a status change - from **any**
source - surfaced on the scrollers up to two minutes before the header. The fix subscribes
`DashboardWidgetService` to the _existing_ `book.status-changed` event (Node `EventEmitter`, same
`.on()` pattern as `StorygraphEventListener`) and calls upstream's `liveCache.clearForScopePrefix`
(shipped in v3.0.0, which let the fork drop its own per-user scope tracking), so the header
refetches the moment status flips. `dashboard.module.ts` imports `AchievementModule` (already
exported) to inject the emitter. Nothing here is Audiobookshelf-specific - it fixes the lag for Kobo,
KOReader and manual edits too - so it is a **generic upstream improvement and should be proposed
upstream**. It survives plugin removal untouched. Carried because the ABS reread flip is what made the
lag visible.

## Reading-alignment overlay (second permanent feature)

The fork carries a **second** overlay beside Audiobookshelf: **ebook <-> audiobook cross-format
alignment**. A Whisper build samples the audiobook, matches transcripts to EPUB spine text, and stores
anchors; a progress-sync listener projects progress across a linked pair - gated by a movement
classifier that only trusts an actively-read side (sudden seeks are quarantined until reading
continues from them for two minutes) - a one-shot reconcile pulls the ebook status up to a fresher,
positionally-ahead audiobook when a pair becomes ready, and an open-time resolver
returns a precise ebook resume point. Upstream has no analogue, so this is maintained here indefinitely
under the same rules as ABS.

**Owned (fork-only) modules - never conflict:** `server/src/modules/reading-alignment/`,
`server/src/modules/edition-link/`, and the client feature files (`features/reader/shared/composables/
useCrossFormatResume.ts`, `features/reader/epub/composables/crossFormatResumeNav.ts`,
`features/book/composables/useReadingAlignment.ts` / `useEditionLink.ts`, and the `*Control.vue`
components).

**Schema decoupling (same pattern as ABS):** three tables - `audiobook_alignment`,
`audiobook_alignment_anchor`, `book_edition_links` - are applied at runtime by
`ReadingAlignmentSchemaBootstrapService` and `EditionLinkSchemaBootstrapService` (`OnApplicationBootstrap`)
from SQL embedded in each module's `schema/*-schema.ts`. They are **not** reachable from
`db/schema/index.ts` (drizzle-kit ignores them; `db:generate` reports no changes), use `db.select()`,
and add no migration to `server/src/db/migrations/`. `ReadingAlignmentSchemaBootstrapService` also resets
interrupted `building` rows on boot.

**Seams / hooks in shared files (keep minimal + generic):**

| Shared file                                             | Hook                                                                                                                                                           | Conflict cost                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `app.module.ts`                                         | register `ReadingAlignmentModule` + `EditionLinkModule`                                                                                                        | 2 lines, trivial                                                    |
| `reader/epub/epub.service.ts`                           | `extractSpineText()` added + exported (spine text for matching/backfill)                                                                                       | real; a generic method, reused by the module - keep it generic      |
| `config/config.ts`                                      | `whisperPath`/`whisperModel`/`ffmpegPath`/`readingAlignment*` on `appConfig`                                                                                   | additive                                                            |
| `achievement-events.service.ts` + `koreader.service.ts` | `occurredAt` (effective activity time) on the progress event                                                                                                   | **generic, shared with ABS**, additive/removable - propose upstream |
| client `DetailsTab.vue`                                 | `<LinkBookControl>` in the action bar                                                                                                                          | keep additive (do not relocate upstream buttons)                    |
| client `ReadingLogTab.vue` / `ReadingAttemptHistory`    | `<ReadingAlignmentControl>` via the generic `#actions` slot                                                                                                    | clean slot pattern                                                  |
| client `ReaderView.vue`                                 | open-time `fetchEbookCrossFormatResume`, passed to `useFoliate` as the `crossFormatResume` open option; wins over saved CFI and media-overlay positions        | one option field, one branch, a `{ crossFormatResumed }` return     |
| `book/book.repository.ts`                               | `EXTRA_PROGRESS_SOURCE` token (optional) feeds an N-way newest-wins merge in `enrichBookIds`; the SQL lives in `edition-link/edition-link-progress.service.ts` | one constructor param, one `Promise.all` entry, the merge branch    |
| `Dockerfile`                                            | `whisper-builder` stage compiles whisper.cpp `v1.9.1` (CPU-only, static) -> `whisper-cli`; runtime adds `libstdc++`/`libgomp`                                  | isolated stage + one COPY                                           |

**Runtime deps (feature is OFF by default):** `whisper-cli` (bundled) + `ffmpeg` (already present) +
a GGML model, downloaded automatically on first build into `<APP_DATA_PATH>/models` (`WhisperModelService`;
`WHISPER_MODEL` defaults to `base.en`, accepts any whisper.cpp model name or an absolute file path).
Enable with `READING_ALIGNMENT_ENABLED=true`; `WHISPER_PATH` defaults to the bundled binary;
`FFMPEG_PATH` defaults to `ffmpeg`. See `.env.example`.

**Plugin removal:** unregister both modules in `app.module.ts`. The app still builds and runs: the
resolver route 404s and the client falls back to its normal saved-position restore; the progress-sync
listener simply isn't registered; the link/alignment controls hide when no pair exists. The fork Vue
component files must remain for the client to compile (expected UI-registration coupling). The three
tables are left in place, unused.

**Watched cross-module import:** two fork files import the pure helpers `applyPathMappings`/
`pathMatchesPrefix` (and the `PathMapping` type) from upstream's `migration/planner/` for the
path-mapping match tier, rather than reimplementing it: `audiobookshelf-match.utils.ts` (ABS) and
`storyteller-path.utils.ts` (Storyteller) - deliberate reuse over reinvention in both. Signature drift
(a rename, a moved file, a changed parameter) breaks both at typecheck; behaviour drift that keeps the
signature is caught by the upstream-contract tests in `audiobookshelf-upstream-contract.test.ts`, which
pin the no-match passthrough, longest-source-prefix ordering, the skipping of a prefix that normalizes
to empty, and `pathMatchesPrefix`'s trailing-slash handling. `storyteller-path.utils.test.ts` adds a
module-boundary test pinning the exact import list; it has no test of the upstream helpers' contract
in isolation, but its own `toRemotePath`/`toLocalPath` tests drive them through `translate` and would
catch the same behaviour drift. Re-point or inline the two functions in both files if they move.
Audio-format predicates in ABS, `reading-alignment`, `edition-link` and `storyteller` come from
`@bookorbit/types` (`AUDIO_FORMAT_LIST` / `isAudioFormat`), not from `scanner/lib/classify.ts`.

**Audio play order must match upstream's manifest.** `reading-alignment.repository.ts`
`compareAudioPlayOrder` replicates `AudiobookService.loadManifestContext` (sortOrder with null last,
then `naturalCompare(basename)`), because absolute positions are derived from the ordering on both
sides; a divergent tiebreak silently writes wrong percentages. Re-check it whenever upstream touches
that comparator. The projection's percentage divides by the sum of file durations (upstream's player
prefers `book_metadata.duration_seconds`); they differ only when that column is overridden.

**Merge notes:** the progress-sync projection into reading-state is the irreducible core coupling (like
ABS). `extractSpineText` on `epub.service.ts` is the one seam worth watching on an upstream EPUB
refactor. The `occurredAt` widening is shared with ABS - resolve it once.

## Monitored overlay (third permanent feature)

The fork carries a **third** overlay: Sonarr-style monitoring of authors and individual books.
Bibliographies are reconciled from Hardcover, Goodreads and Audible (Google Books corroborates),
each work gets per-format (ebook / audio) release dates, a release watcher notifies the owner when
a monitored release becomes available, and per-format auto-download rides the upstream
book-requests pipeline through a fork-owned nullable `book_requests.auto_grab` column. Upstream has
no analogue (its release profiles filter releases per request; they do not watch authors), so this
is maintained here indefinitely under the same rules as ABS.

**Owned (fork-only) code - never conflicts:** `server/src/modules/monitored/` (providers, reconcile,
schema, settings, release watcher, notifier, scheduler), `client/src/features/monitored/`,
`packages/types/src/monitored.ts` and `monitored-settings.ts`, and the book-request auto-grab
bootstrap plus its module-local `pgTable` under `server/src/modules/book-request/schema/`.

**Schema decoupling (same pattern as ABS):** eight monitored tables plus `monitored_settings` are
applied at runtime by `MonitoredSchemaBootstrapService` from SQL embedded in
`modules/monitored/schema/monitored-schema.ts`, never reachable from `db/schema/index.ts`, and read
through `db.select()` on module-local `pgTable` declarations. Monitored settings live in the
monitored-owned table, not in `app_settings` (they did until 2026-09-16; the legacy keys are read
once to seed the table and then ignored).

**Seams / hooks in shared files (keep minimal + generic):**

| Shared file                                                                       | Hook                                                                                                | Conflict cost                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `metadata-fetch/providers/hardcover/hardcover.client.ts` + types                  | author search + contributions queries, opt-in `surfaceFailures`; reuses `BOOK_FIELDS`               | real; the largest monitored hook, generic GraphQL           |
| `book-request/book-request.repository.ts`                                         | `auto_grab` column join, create passthrough, `findDueForResearch(instanceAutomationOn, ...)`        | real                                                        |
| `book-request/fulfillment/request-automation.service.ts`                          | `grabAllowed(request, settings)` = `request.autoGrab ?? settings.autoGrabEnabled`                   | real; see the auto-search note below                        |
| `book-request/indexers/indexer-search.service.ts`                                 | `IndexerSearchRequest` Pick so monitored can search without a full request row                      | additive                                                    |
| `book-request/book-request.service.ts` + `dto/`                                   | thread `autoGrab` / `deferAutomation`                                                               | additive                                                    |
| `book-request/book-request.module.ts`, `authors/authors.module.ts`                | exports used by the monitored module                                                                | trivial                                                     |
| `authors/author-enrichment-executor.service.ts`                                   | `allowOrphan` flag                                                                                  | additive                                                    |
| `authors/authors.repository.ts`                                                   | name lookup/create + portrait candidates (orphan delete moved to the monitored store on 2026-09-16) | real                                                        |
| `packages/types/src/notification.ts`, client notification groups                  | one notification type + category                                                                    | trivial (enum-widening, same pattern as ABS)                |
| client `book-requests/components/RequestSearchPanel.vue`                          | quick-monitor bell, state in `useMonitorGroupAction()`                                              | additive                                                    |
| client `author/views/AuthorsView.vue`, `AuthorTile.vue`, `AuthorIndexRow.vue`     | monitor action + menu item via `useMonitorAuthorAction()`                                           | additive                                                    |
| client `router/index.ts`, `useSidebarNav.ts`, `AppSidebar.vue`, `settings-nav.ts` | route / nav / badge registration                                                                    | additive (upstream restructures these; expect small merges) |

**Auto-search decision (deliberate, revisit if it bites).** Upstream skips unattended re-search when
either instance toggle (auto search, auto grab) is off. The fork's `findDueForResearch` uses
`coalesce(auto_grab, instanceAutomationOn)`, so a monitored request (`auto_grab = true`) keeps being
re-searched even when the operator turns instance auto-search off; ordinary requests still follow
the instance toggles. Monitoring is itself the opt-in that spends those indexer queries, and
turning monitoring off stops it. If you want the instance toggle to win, gate as
`autoSearchEnabled && coalesce(auto_grab, autoGrabEnabled)`.

**Ownership.** Monitored rows are owner-scoped with no superuser bypass (stricter than
`SmartScopeService`); every mutating route is permission-gated. Upstream's delegated-admin fix
(v2.10.0) does not apply: monitored uses `isSuperuser` only to widen library visibility, matching
upstream's own `findCards` idiom.

**Plugin removal:** unregister `MonitoredModule` in `app.module.ts`. Nothing upstream depends on the
monitored tables any more (the last raw `monitored_authors` reference in `authors.repository.ts`
moved into the monitored store on 2026-09-16). The client's route and sidebar registrations remain
as expected UI-registration coupling.

**Deferred (known, not yet done):**

- `reconcile/observation-matcher.ts` `normalizeText` is ASCII-only where upstream's
  `common/text-match/title-match.ts` `normalizeTitleText` is Unicode-aware; non-Latin titles
  normalize to empty and fall back to the degenerate-core guards. Adopting upstream changes
  clustering keys for existing catalogs, so it needs a re-reconcile test first.
- `leaseReleaseEvent` in `monitored-store.service.ts` is not transactional with `notify()`; a crash
  between lease and dispatch leaves `notifiedAt` set and the notification is never retried.
  A stale-lease reaper would close it.

## Storyteller read-along overlay (fourth permanent feature)

The fork carries a **fourth** overlay: an instance-level connection to a
[Storyteller](https://storyteller-platform.gitlab.io/storyteller/) server that generates read-along
EPUB3s (word-level narrated ebooks) from an ebook <-> audiobook pair already linked by the
reading-alignment overlay's edition-link. One admin-configured server and service account serves every
BookOrbit user; BookOrbit registers the pair with Storyteller (by shared path or by uploading it),
starts alignment, waits for the result, and imports the finished EPUB as a new book that becomes the
third member of the link. Upstream has no analogue, so this is maintained here indefinitely under the
same rules as ABS. See [`docs/STORYTELLER_READ_ALONG.md`](docs/STORYTELLER_READ_ALONG.md) for the
operator-facing setup guide (service account, transports, shared-storage mounts, env vars).

**Owned (fork-only) code - never conflicts:** `server/src/modules/storyteller/` (controller, settings
service, encryption, the typed Storyteller API client, path-mapping and existing-book matching utils,
the build orchestrator and status service, schema), `client/src/features/storyteller/`
(`useStorytellerSettings.ts` + `StorytellerSettings.vue`), and the read-along pieces of the
reading-alignment overlay's own fork-owned files (`client/src/features/book/composables/useReadAlong.ts`,
`client/src/features/book/components/detail/tabs/ReadAlongMemberRow.vue`, and the `readAlongBookId` /
`role` / `members` additions in `edition-link/*` and `useEditionLink.ts`). Three common utils, each shared by this
module without an inter-module import: one moved out of `reading-alignment`, one out of
`audiobookshelf`, and one new:
`server/src/common/utils/audio-play-order.utils.ts` (upstream's audio manifest ordering, needed by
both integrations to derive absolute positions), `path-prefix-mapping.utils.ts` (prefix rewriting
between two servers sharing storage, modelled on the ABS path-mapping matcher and deliberately a
separate copy: ABS keeps its own in `audiobookshelf-match.utils.ts`, and importing it here would
couple two integrations that must stay independently removable), and
`self-hosted-service-url.utils.ts` (SSRF-safe parsing for a user-supplied self-hosted server URL,
shared by every fork integration that polls one on a schedule).

**Schema decoupling (same pattern as ABS):** `storyteller_settings` (single row: connection, path
mappings, target library/folder, transport, encrypted password) and
`storyteller_read_along_builds` (one row per build: source/output book ids, Storyteller book uuid,
transport, phase, status, progress) are applied at runtime by `StorytellerSchemaBootstrapService` from
SQL embedded in `modules/storyteller/schema/storyteller-schema.ts`, never reachable from
`db/schema/index.ts`, read through `db.select()` on module-local `pgTable` declarations in
`storyteller.schema.ts`. `book_edition_links.read_along_book_id` (nullable FK to `books`, `ON DELETE
SET NULL`, partial unique index) is a column added to the reading-alignment overlay's own
`edition-link-schema.ts` bootstrap, not a new table - it stays fork-owned because the table it extends
already is.

**Seams / hooks in shared files (keep minimal + generic):**

| Shared file                                                  | Hook                                                                                                 | Conflict cost                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `app.module.ts`                                              | register `StorytellerModule`                                                                         | 2 lines, trivial                                     |
| `packages/types/src/index.ts`                                | `export * from "./storyteller"`                                                                      | 1 line, trivial                                      |
| `integration-tabs.ts`                                        | `storyteller` tab entry, gated on `Permission.ManageAppSettings`                                     | additive                                             |
| `router/index.ts`                                            | `settings-storyteller` route + `INTEGRATION_ROUTES` entry, same shape as every other integration tab | additive                                             |
| `en.json`                                                    | `settings.integrations.storyteller.*` + `book.detail.editionLink.readAlong.*` keys                   | additive, en-only                                    |
| client `LinkBookControl.vue` / `ReadingAlignmentControl.vue` | "Generate read-along" tick box / button and the read-along member row via `ReadAlongMemberRow.vue`   | additive, same slot pattern as the alignment overlay |
| `settings-nav.ts`                                            | `storyteller` entry under ACCOUNTS, same shape as every other integration                            | additive                                             |

**Access control is entirely BookOrbit's, not Storyteller's.** `GET/PUT settings` and `POST
settings/test` require `Permission.ManageAppSettings`; `POST read-along/books/:bookId/build` and `GET
.../existing` require `Permission.LibraryUpload` plus the requester's normal library access to every
member book; replacing an existing read-along additionally requires `Permission.LibraryDeleteBooks`,
since the build deletes the output it supersedes. Storyteller's own per-user accounts and reading state are never read; the service account
configured in Settings is the only identity BookOrbit authenticates as.

**Runtime deps (feature is inert until configured):** no new packages and no Dockerfile change - the
client is native `fetch` and the server calls out over HTTP. `STORYTELLER_ENCRYPTION_KEY` /
`STORYTELLER_REQUEST_TIMEOUT_MS` / `STORYTELLER_TRANSFER_TIMEOUT_MINUTES` /
`STORYTELLER_WAIT_CEILING_MINUTES` are all optional with documented defaults (see
`server/.env.example`); with no Storyteller server configured under Settings, the connection is simply
unset and the read-along tick box stays disabled with the reason why.

**Plugin removal:** unregister `StorytellerModule` in `app.module.ts`, then remove `storyteller` from
`INTEGRATION_TABS` (and its `INTEGRATION_TAB_INFO` entry) in `integration-tabs.ts` together with the
`storyteller` entry in `INTEGRATION_ROUTES` and the `settings-storyteller` route in `router/index.ts`.
`INTEGRATION_ROUTES` is typed `Record<IntegrationTab, string>`, so the two sides must move together:
drop `storyteller` from `INTEGRATION_TABS` while its `INTEGRATION_ROUTES` entry survives and the client
fails to typecheck on an excess property; drop the `INTEGRATION_ROUTES` entry first and it fails on a
missing property instead. Also drop the `storyteller` item from the `accounts` group in
`settings-nav.ts`, or it is left pointing at a route that no longer exists. The app still builds and
runs otherwise: the settings panel and the read-along tick box/row disappear from the UI,
`book_edition_links.read_along_book_id` and the two storyteller tables are left in place unused, and
any book Storyteller had already produced stays exactly where it landed as an ordinary book. The fork
Vue component files must remain for the client to compile (expected UI-registration coupling, same as
the other three overlays).

## Investigated and rejected - do not re-chase

Each of these was analysed and deliberately left alone. Re-attempting them wastes time.

- **`audio.extractor.ts`** - 188 raw but only **26 semantic**. Upstream already owns the
  ASIN / `audible_asin` / `librofm_isbn` extraction and all audiobook parsing. The sole
  fork change is removing upstream's `try/catch` so ffprobe failures propagate instead of
  being swallowed (deliberate: "propagate audio probe failures"). **Nothing ABS-specific
  to extract**; a seam would add surface.
- **`scanner/scanner.service.ts`** - a first metadata-source-provider seam was built,
  measured (211 -> 251), and reverted on footprint. A redesigned variant
  (`EXTRA_METADATA_SOURCES` + `importProvidedCover`) was later landed anyway by the
  footprint-reduction work; after the v2.10.0 merge it measures **287 semantic** and is
  still the largest hook. Correction (2026-09-16): the `sidecar*` identifiers it carries
  are **upstream vocabulary** - `library.constants.ts` lists `sidecar` in
  `LIBRARY_METADATA_PRECEDENCE_DEFAULT` and upstream never implemented that slot - so
  they are not fork identifiers and principle 4 is not violated; the file has zero
  `audiobookshelf` / `abs` tokens. Upstream shipped nothing to `scanner/` or `metadata/`
  in v2.8 to v2.10, and its only cover registry (`COVER_PROVIDERS`) is a remote-search
  interface with a closed key union, so no upstream change enables a shrink. Status:
  **Phase B item**, fork-internal only: collapse the `refreshCovers` fan-out behind one
  fork-owned helper (about -20) and move `importProvidedCover`'s body into a metadata
  service (about -60 out of this file). Do not add to it in the meantime.
- **`hardcover/hardcover-import.service.ts`** - resolved by the v2.7.0 rebase. Upstream
  extracted its own scoring into `hardcover-import-fuzzy-index.ts`, so the fork's moved
  helpers now live in the fork-owned `common/utils/fuzzy-match.utils.ts`, imported only by
  ABS matching and edition-link. `hardcover-import.service.ts` is byte-identical to
  upstream again and the old delete/modify merge hazard is gone. Re-checked 2026-09-16:
  thresholds are still byte-identical to upstream's, but upstream exports only
  `HardcoverImportFuzzyIndex` (a whole-library inverted index over `PreparedText`
  structs, single best match above a fixed confidence) and no pairwise string helpers,
  while the three fork call sites score pre-narrowed candidate batches (one scores series
  names). **Not substitutable; the copy stays.** It now carries upstream's
  `MAX_MATCH_TEXT_LENGTH` input cap, which the copy had missed. Re-check on each merge.
- **`audiobookshelf/audiobookshelf-cover-refresh.service.ts`** - was a copy of upstream
  `BookService.bulkReExtractCover`; since the v3.1.0 merge it is a **wrapper**. Upstream's per-medium
  re-extract plus its slot reconciler (which fills empty slots from folder images) already covers a
  sidecar ranked below embedded, so only books whose library ranks the sidecar **above** embedded are
  taken out of upstream's run and applied here, in bounded-concurrency batches. Delete it the day
  upstream lets a folder image outrank embedded art.
- **`monitored/monitored-exception.filter.ts` cause-chain walk** - duplicates the one-hop
  unwrap in upstream `common/utils/db-error.utils.ts`, but hoisting a shared
  `findPgErrorCode()` into that upstream file would add ~10 upstream lines to delete 25
  fork-only lines. Net loss on the surface that matters; rejected.
- **Upstream `AudiobookEbookProgressSyncService` vs the alignment overlay** (checked at the v3.0.0
  merge). Upstream's sync maps positions through an EPUB3 media-overlay (SMIL) playlist between
  the audio file and a Storyteller-style read-aloud EPUB of the **same book**, and refuses pairs
  whose durations differ by more than 5%. The fork's alignment projects across an **edition link
  between two separate books** using Whisper anchors against ordinary EPUBs with no overlay.
  Different inputs, different scope: **not substitutable, both stay.** They write disjoint rows
  (same-book files vs the linked counterpart), so they do not fight; re-check if upstream ever
  extends its sync across books.
- **Upstream `TtsTextExtractorService` vs `EpubService.extractSpineText`** (checked at the v3.0.0
  merge). Upstream's extractor serves one chapter per call (it reopens the zip each time), is not
  exported from `TtsModule`, and splits text with `htmlToBlocks`, whereas alignment matching reads
  the whole spine in one pass through `extractVisibleText`. Swapping normalizers would shift every
  stored anchor. **Not substitutable; the seam stays.**
- **`book.repository.ts` edition-link progress merge** - moved behind the generic
  `EXTRA_PROGRESS_SOURCE` token on 2026-09-16 (fork-owned provider in `edition-link/`),
  which restores plugin isolation; the merge branch itself is the irreducible part.

## Where the remaining work is

After the v2.10.0 merge and review pass (2026-09-16): five seams landed, and modified
upstream source files carry 1607 semantic lines across 80 files (locales and tests
excluded) for three overlays. The files above the bar are `scanner.service.ts` (287, Phase B,
fork-internal shrink only) and `metadata.service.ts` (134, cover precedence); the monitored
Hardcover client additions (123 + 85 types) are the next largest and are generic GraphQL.
The rest is genuine core coupling - progress sync into reading state, provider-ID unions,
registration lines - plus the propose-upstream queue below.

If a future ABS feature needs to reach into an upstream file, apply the principle above:
prefer a generic hook, and **measure `-w` before and after** to confirm it actually
shrinks the footprint.

### Propose upstream (each deletes fork lines for good)

- `scanner.service.ts`: the `!selfWriteInProgress` guard the fork adds to steps 3c/3d/3e;
  upstream applies it to 3a/3b and states the rule in its own comment.
- `metadata.service.ts`: `!= null` instead of `!== undefined` for `audibleId` /
  `librofmId` so an automated `null` cannot clobber a higher-precedence ID, and
  `tags` / `isbn10` / `isbn13` parity in `persistAudioMetadata` via upstream's `replaceTags`.
- `dashboard-widget.service.ts`: subscribe to `book.status-changed` and bust the user's live
  scopes. (`clearForScopePrefix` itself shipped upstream in v3.0.0 and the fork now calls it.)
- `client useBookProgressRefresh`: pass the event to the callback; the fork's detail tabs
  would then filter by `bookId` again instead of relying on the debounce.
- `achievement-events.service.ts` / `koreader.service.ts`: the `occurredAt` widening, and
  the `audiobookshelf` member of the progress-source enums.
- `audiobook.service.ts`: emit `book:progress-changed` from `putPlaybackState`; upstream's
  web reader already emits it for ebooks.
