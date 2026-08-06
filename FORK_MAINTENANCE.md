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

1. **Dead / redundant / non-functional code is a finding only when it is *ours*.** Upstream's own
   dead code, awkward code, or latent bugs are **out of scope**: do not flag them and never "fix"
   them. We do not maintain upstream's internals, and touching an upstream file to tidy it only grows
   the conflict surface - the opposite of the goal. Leave upstream files byte-identical to upstream
   unless a hook genuinely earns its place (see "Guiding principle").

2. **Fork code that duplicates upstream behaviour is redundant - delete it and call upstream.** If a
   helper, method, or branch we added reproduces something upstream already does, and the behaviour is
   **identical**, remove ours and route callers to the upstream function. Reinventing read-status
   updates, progress/percent-read writes, percentage math, library-access checks, or book lookups that
   upstream already exports is the canonical form of this finding.

3. **This rule is strongest at merge time.** A merge is where the fork should get *smaller*, not
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
   upstream call plus a small adapter for the difference - is *more maintainable than a standalone fork
   implementation*. If it is, wrap upstream: the bulk of the logic stays on upstream's side and the
   fork surface shrinks (this is the same footprint test as a seam - the wrapper must be smaller than
   what it replaces). Only when even a wrapper is more code, or more fragile, than owning it outright
   do you keep a fully separate fork implementation - and then comment *why* it diverges, so the next
   reviewer does not "deduplicate" it back into a regression.

5. **Deliberate code-moves are not duplication.** Extracting upstream code verbatim into a fork-only
   file for reuse (e.g. `book-match.utils.ts`) is the sanctioned way to share upstream logic without
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

- **`audiobookshelf-support` is this fork's `main`.** Set it as the default branch on
  your origin fork. (Consolidate `abs-metadata-json-sidecar` into it - one fork branch.)
- **Merge upstream, never rebase.** Merging preserves fork history and keeps conflict
  resolution incremental.
- **Merge frequently and small.** A 15-commit gap is what made one merge painful.
  Merge per upstream release (or weekly); small merges = trivial conflicts.

## The merge ritual

```
git fetch upstream
git merge upstream/main       # resolve per the audit below

cd server
pnpm build                                  # source typecheck, expect 0 issues
npx vitest run src/modules/audiobookshelf   # ABS suite must stay green
pnpm test                                   # full suite

git commit
```

While resolving conflicts, apply **"Reviewing changes"** above: if the incoming upstream code now does,
identically, what a fork-added helper does, replace the fork helper with a call to upstream rather than
re-resolving around it. The merge is the moment to shrink the fork, not just re-carry it.

**Migrations no longer need any merge step.** `server/src/db/migrations/` is
byte-identical to upstream (see "Schema decoupling"), so upstream migrations flow in
untouched and `_journal.json` can no longer collide.

Known pre-existing upstream failures (**not** caused by the fork): the
`published-date.utils` timezone bug, which also fails `kobo.scraper.test.ts`. Don't
chase these during a merge.

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

## Landed seams - the pattern to copy

Both live in upstream files, contain **zero ABS identifiers**, and are supplied from
`modules/audiobookshelf/` through the `@Global` `AudiobookshelfMetadataModule`:

| Seam              | Upstream file                             | Token                         |
| ----------------- | ----------------------------------------- | ----------------------------- |
| Format extractors | `metadata/metadata-extraction.service.ts` | `EXTRA_METADATA_EXTRACTORS`   |
| Cover sources     | `metadata/cover-source-handler.ts`        | `EXTRA_COVER_SOURCE_HANDLERS` |

The cover seam removed every ABS identifier from `metadata.service.ts` and changed
`scanner.service.ts` by exactly one line (`applyCoverSource({ kind: 'sidecar', ... })`).

## Current conflict surface (semantic, `-w`)

| File                                                                                  | Semantic   | Status                                    |
| ------------------------------------------------------------------------------------- | ---------- | ----------------------------------------- |
| `scanner/scanner.service.ts`                                                          | 211        | irreducible - see rejected                |
| `metadata/metadata.service.ts`                                                        | 153        | generic (post-seam), no ABS identifiers   |
| `hardcover/hardcover-import.service.ts`                                               | 86         | pure code-move - see rejected             |
| `book/book.repository.ts`                                                             | 44         | irreducible core                          |
| `user-book-status/reading-attempt.service.ts`                                         | 36         | irreducible core                          |
| `book/book.service.ts`                                                                | 35         | irreducible core                          |
| `metadata/extractors/audio.extractor.ts`                                              | 26         | see rejected                              |
| `metadata/metadata-extraction.service.ts`                                             | 12         | the extractor seam itself                 |
| `metadata/lib/cover.ts`                                                               | 11         | shared helper                             |
| `scanner/scanner.repository.ts`                                                       | 10         | sidecar query support                     |
| `scanner/lib/classify.ts`                                                             | 6          | sidecar format recognition                |
| client: `LibraryCreatorMetadata.vue` / `integration-tabs.ts` / `useLibraryCreator.ts` | 12 / 7 / 6 | UI registration                           |
| client: `book/.../tabs/ReadingLogTab.vue` / `DetailsTab.vue`                          | 3 / 3      | **generic, propose upstream** - see below |
| `dashboard/dashboard-widget.service.ts` / `dashboard.module.ts`                       | ~10 / 2    | **generic, propose upstream** - see below |
| `app.module.ts`, `packages/types/*`, `reading-attempt.repository.ts`                  | 2 each     | trivial                                   |
| `client/src/locales/*.json`                                                           | small      | i18n keys, trivial conflicts              |

**`ReadingLogTab.vue` / `DetailsTab.vue` live-refresh (generic, not ABS-coupled).** Each subscribes
the book-detail tab to the _existing_ `book:progress-changed` socket event via the _existing_
`useBookEvents().onBookProgressChanged` hook, and calls its _existing_ `reload()` / `loadSupplemental()`
when the event's `bookId` matches the open book. Nothing here is Audiobookshelf-specific: upstream's
own local web reader (and Kobo/KOReader) already emit `book:progress-changed`, so this makes the
reading-log and details tabs live-update for **every** progress source - they don't today. It survives
plugin removal (the ABS emit just stops being one of the emitters). Carried in the fork because the
ABS warm-session tier needs something listening, but it is a **generic upstream improvement and should
be proposed upstream** rather than maintained here long-term. ~3 lines each, wiring existing primitives.

One backend line travels with it: the ABS sync emits `book:progress-changed` with `source:
'audiobookshelf'`, which required adding `'audiobookshelf'` to the `BookProgressChangedEvent.source`
union (`packages/types/src/scanner.ts`) and its server twin (`achievement-events.service.ts`). This is
the **same enum-widening pattern** already carried for `reading_sessions.source` /
`reading_attempts.origin` (commit `be8bd0e0`): a provider naming itself in a shared enum, additive and
removable (drop the plugin and the member is simply unused). It belongs on the same **propose-upstream**
list as those enum members - the alternative, reusing a false `web_reader`/`koreader` literal, would
write dishonest source data.

**`dashboard-widget.service.ts` live-cache invalidation (generic, not ABS-coupled).** The
"Currently Reading" header is served from a 120s `liveCache`, while the scrollers
(`dashboard.service.ts`, e.g. Continue Listening) are uncached. So a status change - from **any**
source - surfaced on the scrollers up to two minutes before the header. The fix subscribes
`DashboardWidgetService` to the _existing_ `book.status-changed` event (Node `EventEmitter`, same
`.on()` pattern as `StorygraphEventListener`) and calls `liveCache.clearForScope(userId)`, so the
header refetches the moment status flips. `dashboard.module.ts` imports `AchievementModule` (already
exported) to inject the emitter. Nothing here is Audiobookshelf-specific - it fixes the lag for Kobo,
KOReader and manual edits too - so it is a **generic upstream improvement and should be proposed
upstream**. It survives plugin removal untouched. Carried because the ABS reread flip is what made the
lag visible.

## Reading-alignment overlay (second permanent feature)

The fork carries a **second** overlay beside Audiobookshelf: **ebook <-> audiobook cross-format
alignment**. A Whisper build samples the audiobook, matches transcripts to EPUB spine text, and stores
anchors; a progress-sync listener projects progress across a linked pair, and an open-time resolver
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

| Shared file | Hook | Conflict cost |
| --- | --- | --- |
| `app.module.ts` | register `ReadingAlignmentModule` + `EditionLinkModule` | 2 lines, trivial |
| `reader/epub/epub.service.ts` | `extractSpineText()` added + exported (spine text for matching/backfill) | real; a generic method, reused by the module - keep it generic |
| `config/config.ts` | `whisperPath`/`whisperModel`/`ffmpegPath`/`readingAlignment*` on `appConfig` | additive |
| `achievement-events.service.ts` + `koreader.service.ts` | `occurredAt` (effective activity time) on the progress event | **generic, shared with ABS**, additive/removable - propose upstream |
| client `DetailsTab.vue` | `<LinkBookControl>` in the action bar | keep additive (do not relocate upstream buttons) |
| client `ReadingLogTab.vue` / `ReadingAttemptHistory` | `<ReadingAlignmentControl>` via the generic `#actions` slot | clean slot pattern |
| client `ReaderView.vue` | open-time `fetchEbookCrossFormatResume` + resume ladder | fork-owned logic invoked from the reader open path |
| `Dockerfile` | `whisper-builder` stage compiles whisper.cpp `v1.9.1` (CPU-only, static) -> `whisper-cli`; runtime adds `libstdc++`/`libgomp` | isolated stage + one COPY |

**Runtime deps (feature is OFF by default):** `whisper-cli` (bundled) + `ffmpeg` (already present) +
a GGML model (NOT bundled - mount and set `WHISPER_MODEL`). Enable with `READING_ALIGNMENT_ENABLED=true`;
`WHISPER_PATH` defaults to the bundled binary; `FFMPEG_PATH` defaults to `ffmpeg`. See `.env.example`.

**Plugin removal:** unregister both modules in `app.module.ts`. The app still builds and runs: the
resolver route 404s and the client falls back to its normal saved-position restore; the progress-sync
listener simply isn't registered; the link/alignment controls hide when no pair exists. The fork Vue
component files must remain for the client to compile (expected UI-registration coupling). The three
tables are left in place, unused.

**Merge notes:** the progress-sync projection into reading-state is the irreducible core coupling (like
ABS). `extractSpineText` on `epub.service.ts` is the one seam worth watching on an upstream EPUB
refactor. The `occurredAt` widening is shared with ABS - resolve it once.

## Investigated and rejected - do not re-chase

Each of these was analysed and deliberately left alone. Re-attempting them wastes time.

- **`audio.extractor.ts`** - 188 raw but only **26 semantic**. Upstream already owns the
  ASIN / `audible_asin` / `librofm_isbn` extraction and all audiobook parsing. The sole
  fork change is removing upstream's `try/catch` so ffprobe failures propagate instead of
  being swallowed (deliberate: "propagate audio probe failures"). **Nothing ABS-specific
  to extract**; a seam would add surface.
- **`scanner/scanner.service.ts`** - a metadata-source-provider seam was built and
  measured: surface went **211 → 251** and 20+ sidecar identifiers still remained. The
  extractable part (`selectJsonSidecarMetadataFile`, ~5 lines) is dwarfed by the seam
  machinery (~45). The bulk (`importSidecarCover`, cover/metadata precedence interplay)
  is scan-flow orchestration, not a bolt-on. **Reverted.** Build was clean and 1910 tests
  passed - it failed on footprint, not correctness.
- **`hardcover/hardcover-import.service.ts`** - not ABS logic at all. It is a pure
  code-move: 85 lines of private scoring helpers (`normalizeIsbn`, `scoreTitle`,
  `scoreAuthors`, ...) were extracted verbatim to the fork-only
  `common/utils/book-match.utils.ts` so ABS matching could reuse them (commit
  `197df6c0`). Bodies are byte-identical to upstream. Reverting would duplicate 85 lines
  in two places; relocating into the ABS module would invert layering, since
  `metadata/extractors/abs-metadata.mapper.ts` also imports it. **Leave as-is.**

  ⚠️ **Merge hazard:** if upstream ever edits a scoring threshold or regex inside that
  moved block (upstream lines ~637-740), git reports a delete/modify conflict and the
  lazy resolution (accept the deletion) **silently drops the upstream fix**. On merges
  that touch this file, port the change into `book-match.utils.ts` rather than
  discarding it.

## Where the remaining work is

The seam programme is complete: two seams landed, three targets investigated and
rejected. What is left (~500 semantic lines) is genuine core coupling - progress sync
into reading state, book read/write paths, provider-ID type unions, and the one-line
module registration. That is the floor, not a backlog.

If a future ABS feature needs to reach into an upstream file, apply the principle above:
prefer a generic hook, and **measure `-w` before and after** to confirm it actually
shrinks the footprint.
