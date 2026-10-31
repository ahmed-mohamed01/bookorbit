# Fork Maintenance

This is a **personal downstream fork** of BookOrbit. Upstream maintainers have
declined Audiobookshelf support, so this fork carries it as a permanent overlay:

- **Audiobookshelf metadata.json / cover.jpg sidecar support**
- **Audiobookshelf reading-progress + position sync**

It also carries the reading-alignment, Watchlist (`monitored`), Web Serials and read-along
narration player overlays described below.

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

- **`monitored` is this fork's main branch.** It carries every overlay in this document on
  top of upstream. `audiobookshelf-support` and
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
`published-date.utils` timezone bug, which also fails `kobo.scraper.test.ts`; and since
`acce1e15`, `SettingsNav.spec.ts` / `SettingsSidebar.spec.ts` (upstream's `SettingsNav.vue` now
reaches the real router through `useBookRequestVisibility` -> `useAuth`, and its `vue-router` mock
has no `createRouter`). Don't chase these during a merge.

Fork-caused spec drift, which **is** ours to fix at merge time: upstream specs that count
the permission catalog (`UserFormDrawer.spec.ts` expects one more than upstream because of
`audiobookshelf_sync`) and fork spec fixtures that hand-build upstream types
(`MonitoredBookPanel.spec.ts` builds a `ReleaseCandidateItem`; a new required upstream field
breaks it). Each is a one-line catch-up; make it rather than carry a red test.

### Merge log

- **2026-10-28, upstream v3.6.0 (`f2a7a111`), 27 commits.** 33 conflicted files. Upstream added in-app
  read-aloud generation (`workers/read-aloud`, its own `ReadAloudModule`, `read_aloud_*` notifications),
  so the Storyteller overlay was deleted (see its section) instead of carried. Upstream moved audiobook
  chapters into `AudiobookChaptersService` (the fork keeps only `abridged` in `metadata.service.ts`,
  the progress emit beside the new constructor arg in `audiobook.service.ts`) and added grouped
  `GET/PUT /reading-progress` routes: the fork's `progress-writer.ts` now reads through upstream's
  `fetchFileProgress` and saves the grouped write itself, because it needs a request timeout.
  `scanner.service.ts` takes upstream's `storedFilesAsRegistered` with the fork's `storedFileHash`
  field added to it. Upstream's undici/zod overrides replaced the fork's `cheerio>undici` line. The
  fork's earlier removal of the read-aloud sync card in `DetailsTab.vue` stands; upstream's
  `ReadAloudInviteChip` is taken as upstream renders it, beside the format chips. The route inventory is byte-identical to upstream again. Fork
  spec drift: `placeholder` in upstream cover-slot fixtures, the ABS `audibleId` clobber test now
  asserts chapters through `applyFileChapters`.
  A post-merge reuse review then moved fork copies onto upstream: `orderAudiobookTracks` for the
  read-along timeline and alignment repository (a sort-order tie used to diverge from the player),
  `audioToolsConfig.ffmpegPath`, `StatsCache` for both watchlist caches, `chunk`, `readBoundedBytes`
  for ABS covers, `BookReadService.findLibraryIdsByBookIds`, `normalizeTitleText`, `endpointUrl`,
  `BookCoverArtwork` on the watchlist card (a recycled card kept a broken cover's placeholder), and
  `jsonBody` / `readApiErrorDetail` in the ABS client. Upstream's own `carriesMedium`, `roleUnchanged`,
  narration item lookups and `MediaOverlayMiniPlayer.vue` were restored; dead `findMalformedSpineItem`
  and `offsetsSource` were deleted.
  Follow-up on 2026-10-29/30, before the merge commit: a second reuse pass (Tier 2) moved more fork
  copies onto upstream (`resolveStoredAudiobookChapters` for narration chapters, `buildComicInfoXml`
  for Web Serials CBZs, `isPublishedDateKey` for Watchlist dates, `mapWithConcurrency` in the ABS
  scheduler, `isDecodableImage` out of upstream's `cover.ts`). Then the owner moved to upstream's
  same-record model: one book record holds its EPUB, read-along EPUB and audio files, so everything
  that joined separate books was removed (the `edition-link` module and its routes, cross-book
  read-along sync, the merged reading log, Currently Reading stacks, the `EXTRA_PROGRESS_SOURCE`,
  `READ_ALONG_LINK_SOURCE`, `READ_ALONG_OFFSETS_STORE`, `READING_SESSION_SCOPE_SOURCE` and
  `CURRENTLY_READING_GROUP_SOURCE` seams, `read-along-chapter-mapping.ts` and `mp4-faststart.ts`),
  and `resolveAudioPlayOrder` moved from a hunk in `AudiobookChaptersService` to the fork-only
  `AudioPlayOrderService`. Three review and fix passes followed: whisper aligns only the plain EPUB,
  the ABS pull runs upstream's `syncEbookProgressForAudiobookPlayback`, the Watchlist background
  eligibility rule, the Web Serials quota lock and scoped move-to-top, the open-time resolver yields
  to upstream's read-aloud sync, the Position sync trigger shows only when there is something to
  sync, and dead fork code and i18n keys were deleted. Last, whisper was confined to books with no
  read-along (the live projection and the resume both skip a book holding a media-overlay EPUB),
  the panel orders ebook, read-along and audio so upstream's two read-aloud connectors sit between
  their files, upstream's `ReadAloudInviteChip` stays beside the format chips (upstream's one-click
  entry wins over the panel's Create read-along row, which stays too), and the uncalled `POST web-serials/novel/:matchId/batches` route went.
  A live test then found upstream's audio-to-text lookup treating a Storyteller track-boundary clip
  (one that ends before it begins, so its length is unknown) as open-ended: every later position
  landed on it. The fork now gives such a clip what its section's declared length leaves over, in
  both directions, so a boundary clip in the middle of a chapter ends in the right place too.
  On 2026-10-31 the panel's Create read-along ghost became a read-aloud slot driven by upstream's
  generator (`useReadAloud`): one-click Create with the dialog's defaults, Modify opening upstream's
  `ReadAloudDialog`, and the queued, processing (stepper and percent), review and failed states, with
  Review opening the Files tab with the job card's Details expanded.
- **2026-09-30, upstream `acce1e15`, 26 commits.** 7 conflicted files, all small. Upstream added a
  per-user Requests visibility toggle: `notification.repository.ts` `deleteAllForUser` now ANDs the
  fork's locked-row guard with upstream's request filter, and the sidebar still fetches the Monitored
  badge when requests are hidden (Monitored is not a request surface). Upstream's fractional finished
  thresholds replaced `formatPercent` in `LibraryDetailPanel.vue`; the fork keeps only the row
  `v-if`s for the narrower non-superuser projection (42 -> 37). Upstream exported
  `compareAudioTracks` from `book-media.utils.ts`, identical to the fork's `compareAudioPlayOrder`,
  so `common/utils/audio-play-order.utils.ts` was deleted and reading-alignment and Storyteller
  sort with upstream's. Migrations 0099 / 0100 touch neither fork CHECK constraint (no parking).
  Fork spec drift: the notification delete fixture now mocks the user-settings `select`. Verified:
  `verify:fast` green, server 17,240 and client 8,044 tests green apart from the upstream
  `SettingsNav` / `SettingsSidebar` failures above, dev DB migrated through 0100.
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

## Issues, versions and releases

Upstream's process (`docs/RELEASE_PROCESS.md`, semantic-release, `BO-<n>` branches) does not
apply to the fork. The fork tracks work and ships releases like this.

### Issues

Every fork feature, bug and follow-up gets an issue on `ahmed-mohamed01/bookorbit` before work
starts.

- **Labels:** one `type:` (`feat`, `bug`, `chore`), one or more `area:` (`monitored`,
  `storyteller`, `abs`, `reader`, `metadata`, `docker`, `upstream-sync`), optional `status:`
  (`in-progress`, `blocked`).
- **Branches:** `F-<n>-<desc>` for fork issue `#n` (e.g. `F-12-abs-retry-backoff`). The `F-`
  prefix keeps fork numbers apart from upstream's `BO-` numbers. Land on `monitored` by rebase
  and `git merge --ff-only`; upstream syncs stay the only merge commits.
- **Commits:** reference the issue in the footer: `Closes #12`, or `Refs #12` for partial work.
- **Upstream bugs:** label `upstream` and link the `bookorbit/bookorbit` issue. Not ours to fix
  (see "Reviewing changes"); carry a fork patch only when it cannot wait.
- **Closing:** close an issue when its commit is on `monitored`, at the latest when the release
  that carries it ships.

### Versioning

Fork versions are `v<upstream base>-m<N>`, e.g. `v3.1.0-m2`.

- `<upstream base>` is the newest upstream release tag merged into `monitored`
  (`git describe --tags --abbrev=0 --exclude '*-m*' monitored`).
- `N` starts at 1 and increases with each fork release on that base. A merge that brings a new
  upstream release resets it: the next fork release is `v3.2.0-m1`.
- Merging untagged upstream `main` does not change the base; the notes list the synced commit.
- Tags are annotated, signed, and point at a commit on `monitored`.

### Changelog

`CHANGELOG.fork.md` holds fork changes only, newest first. Each entry opens with a hand-written
`### Highlights` list in upstream's style (`- **Title**: one to three user-facing sentences`),
followed by the drafted commit sections: commits on the fork but not upstream, grouped by type,
`Closes #n` references carried over, upstream syncs listed.

The fork's release list keeps upstream and fork changes apart, ordered by when monitored took them
in: `3.4.0`, `3.4.0-m1`, `3.4.0-m2`. A release's place in the list is its tag's date.

- **Upstream entries** (`BookOrbit 3.4.0`): upstream's own release notes, verbatim, never Latest.
  Fork Release creates one for each upstream release a fork release brings in
  (`release-notes.mjs <fork tag> --fresh-upstream`), as an annotated tag dated when monitored
  merged it, so it sorts just below that fork release.
- **Fork entries** (`BookOrbit 3.4.0-m2`) read top to bottom:
  1. **Highlights in `<version>`**: the entry's highlights.
  2. **Upstream changes in this release**, only when this release merged upstream code: a link to
     the upstream entry when the base moved, and the upstream `main` commits merged since the
     previous fork release that no upstream release carries yet.
  3. **Fork changes in `<version>`**: the rest of the `CHANGELOG.fork.md` entry.
  4. **Docker**: the `docker pull` line, for releases that tag an image.

Upstream `#123` references are rewritten to `bookorbit/bookorbit#123` so they do not link to fork
issues.

### Cutting a release (every push of `monitored`)

Every push of `monitored` is a release. `scripts/fork/release.mjs` runs it from the `monitored`
checkout with a clean tree:

1. `node scripts/fork/release.mjs prepare` fetches upstream and tags, picks the next version
   (`v<base>-m<N>`), drafts its entry at the top of `CHANGELOG.fork.md` from the commits since the
   previous fork tag, and prints the exact GitHub Release body. It stops with "nothing new" when
   there is nothing to release.
2. Replace the highlights placeholder, edit the entry, and re-check it with
   `node scripts/fork/release.mjs preview`. **The notes are approved before anything is pushed.**
3. `node scripts/fork/release.mjs publish v3.4.0-m2` commits `docs(release): v3.4.0-m2` (signed),
   pushes `monitored` through the pre-push gate, then creates and pushes the signed tag. It refuses
   a missing entry or a placeholder still in place.
4. `.github/workflows/fork-release.yml` waits for the Container Image build of that commit, tags it
   `ghcr.io/ahmed-mohamed01/bookorbit:3.4.0-m2` and `:latest` without rebuilding, and publishes the
   GitHub Release.
5. Close any issues the release finished.

Only the highest fork tag moves `:latest` and is marked the latest release. A lower tag (a
backfill) gets a notes-only release: no image tag, not latest, and its changelog entry is read
from `monitored` when the tagged commit predates it. Releases before `v3.4.0-m2` were backfilled
this way: one per upstream base, each tagged at the last `monitored` commit before the next base
came in, plus `v3.4.0-m1` at `bbd8890b`. A tag push runs the workflow file as it was at the tagged commit, so a backfill tag on a commit older than this workflow runs the old one: publish backfills from a local checkout with `gh release create <tag> -R ahmed-mohamed01/bookorbit --verify-tag --latest=false --notes-file <file>`, building the notes with `release-notes.mjs <tag> --release-body --to <tag commit>`. Push at most three tags at once: GitHub sends no push events for larger tag pushes.

Rollback is deploying the previous version tag. Version tags are never rebuilt, so each one is
exactly the image that ran from `monitored`.

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
Every fork feature with schema (ABS, reading alignment, monitored, web serials) follows
these; the pattern is a deliberate fork exception to the CLAUDE.md rule "never hand-write
migration SQL", which exists for upstream contributions - fork schema never goes upstream.

- Never add files under `server/src/db/migrations/`. Fork schema is bootstrap SQL only, so
  new Drizzle ledger entries hold upstream hashes only. Drizzle applies every journal entry newer
  than the ledger's latest timestamp, so one fork migration in the ledger makes the
  upstream image silently skip any upstream migration generated before it.
  `scripts/fork/release.mjs` refuses to prepare or publish while `server/src/db/migrations/` or
  `server/src/db/schema/` differ from upstream at the merge-base, so a fork migration cannot ship.
- Fork tables live in `modules/<feature>/schema/` and are never exported from
  `db/schema/index.ts`.
- A fork column on an upstream table must be nullable, added with
  `ADD COLUMN IF NOT EXISTS` by the module that reads it, and read or written through a
  module-local `pgTable` declared for the same table name - never by editing the upstream
  schema file. Example: `book_requests.auto_grab` is owned by the book-request module
  (`modules/book-request/schema/book-request-auto-grab.schema.ts` plus its bootstrap, which
  runs in `onModuleInit` so the column exists before that module's crons tick).
- The historical pre-Shelfmark fork migrations below must have their ledger rows removed, or
  both images will skip upstream migrations older than them. Between 2026-09-04 and
  2026-09-06 the `monitored` branch shipped migrations 0086 to 0090; on any database that
  ran it (dev and test instances only, never prod), run once:
  `delete from drizzle.__drizzle_migrations where left(hash, 12) in ('960f1671810e',
'550a44aa480d', '8b83e5f0ee7b', '20c8ec37ddf6', 'c5c3e317e464');`
- Do not modify upstream CHECK constraints. The `audiobookshelf` value in
  `reading_sessions_source_chk` and `reading_attempts_origin_chk` is the first accepted
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
- Shelfmark is the second accepted CHECK exception: `download_clients_adapter_type_chk` and
  `book_request_downloads_source_chk`. `ShelfmarkSchemaBootstrapService` OR-extends whatever
  definition upstream currently has with `shelfmark` (so new upstream client types survive) and adds
  the nullable `book_request_downloads.content_file_count` column, owned by
  `modules/book-request/schema/book-request-download-file-count.schema.ts`. A pending upstream
  migration that recreates either constraint first has the Shelfmark rows parked (adapter relabeled
  to `qbittorrent` with `enabled=false`, or source relabeled to `direct_url`, originals recorded),
  and the bootstrap restores them. Upstream's `db/schema/download-clients.schema.test.ts` is
  excluded in `server/vitest.config.ts`; `shelfmark/shelfmark-schema.test.ts` is its fork copy.
- Shelfmark first shipped as Drizzle migrations 0117/0118 (v3.4.0-m2 and m3) and was moved to the
  bootstrap afterwards. Their ledger rows stay on databases that ran them: their timestamps are
  older than upstream 0117 and everything after it, so Drizzle still applies upstream's
  migrations, and a rollback to an m2/m3 image does not rerun the non-idempotent ADD COLUMN.
  `hidden-migration-recovery.ts` reads the fork rows' recorded timestamps, not the journal, to
  replay upstream migrations a database skipped because it ran a fork row first.
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

The token files themselves are fork-authored new files (zero conflict). The residual coupling the
seams could not remove lives in `scanner.service.ts` and `metadata.service.ts` and is tallied
below. The `EXTRA_PROGRESS_SOURCE` and `CURRENTLY_READING_GROUP_SOURCE` seams were deleted with
edition links on 2026-10-29/30.

## Current conflict surface (semantic, `-w`)

> **2026-10-28: the Storyteller overlay was removed** (see its section). Its 2026-09-24 note on 38
> semantic lines across 6 upstream files is history: the `packages/types` export, the `.env.example`
> Storyteller block and the route, nav and tab entries are gone.
>
> **2026-10-30: the rows below were re-checked after the same-record switch** where the review named
> them; the rest of the table still carries the 2026-09-22 numbers (see "Where the remaining work is"
> for the current total).

Measured 2026-09-22, after the upstream v3.0.0 merge (`970b1525`). Source files only (locales,
tests and docs excluded); per-file numbers are added+removed with `-w`. **80 modified upstream
source files, 1614 semantic lines.** The v3.0.0 merge removed about 68 lines of hooks; the total
is level with 2026-09-16 (1607) only because the per-format release-date work that landed in
between added about 75 lines to the Hardcover client. Fork-authored new files never conflict and
are excluded.

| File                                                                                                     | Semantic          | Owner         | Status                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `scanner/scanner.service.ts`                                                                             | 287               | ABS           | Phase B (fork-internal shrink only; see rejected list)                                     |
| `metadata/metadata.service.ts`                                                                           | 134               | ABS           | cover/sidecar precedence, no ABS identifiers                                               |
| `metadata-fetch/providers/hardcover/hardcover.client.ts` + `.types.ts`                                   | 168 / 114         | monitored     | author search, contributions, per-format editions; reuse `BOOK_FIELDS`                     |
| `user-book-status/reading-attempt.service.ts` / `.repository.ts`                                         | 61 / 37           | ABS           | irreducible core (origin-based dedupe, soft-delete aware)                                  |
| `book-request/book-request.repository.ts` / `.service.ts` / dto                                          | 47 / 18 / 8       | monitored     | `auto_grab` column, research filter, create passthrough                                    |
| `reader/epub/epub.service.ts`                                                                            | 128               | alignment     | `extractSpineText` seam + Range/ETag/HEAD streaming via fork-only `EpubMediaStreamService` |
| client `settings/LibrariesSettings.vue` / `LibraryRowActions.vue`                                        | 39 / 10           | ABS           | re-extract metadata library action                                                         |
| `authors/authors.repository.ts`                                                                          | 38                | monitored     | name lookup/create + portrait candidates (was 73)                                          |
| client `reader/ReaderView.vue` / `epub/composables/useFoliate.ts`                                        | 29 / 15           | alignment     | resume ladder via the `crossFormatResume` open option (was 38 / 37)                        |
| `dashboard/dashboard-widget.service.ts`                                                                  | 17                | ABS           | status-change listener (generic, propose upstream)                                         |
| client `author/views/AuthorsView.vue` / `AuthorTile.vue` / `AuthorIndexRow.vue`                          | 35 / 25 / 25      | monitored     | monitor action via `useMonitorAuthorAction()`                                              |
| `.github/workflows/container-image.yml`                                                                  | 32                | fork          | deliberate: any-branch manual builds + stable branch-name image tag                        |
| client `router/index.ts` / `useSidebarNav.ts` / `settings-nav.ts` / `AppSidebar.vue`                     | 28 / 21 / 19 / 12 | mixed         | route, nav and badge registration (ABS + monitored)                                        |
| `achievement/achievement.repository.ts`                                                                  | 4                 | ABS           | `'audiobookshelf'` in upstream's two source `IN` lists (was 22)                            |
| `common/utils/ssrf.utils.ts`                                                                             | 21                | ABS           | generic `blockLinkLocal` option (exported helper) - **propose upstream**                   |
| client `book-requests/components/RequestSearchPanel.vue`                                                 | 20                | monitored     | quick-monitor bell via `useMonitorGroupAction()` (was 75)                                  |
| `.env.example` / `Dockerfile` / `config/config.ts`                                                       | 17 / 15 / 6       | alignment     | whisper stage + alignment config, additive                                                 |
| `audiobook/audiobook.service.ts` / `.module.ts`                                                          | 14 / 3            | ABS+alignment | `book:progress-changed` emit from `putPlaybackState` - **propose upstream**                |
| `book-request/fulfillment/request-automation.service.ts` / `indexers/indexer-search.service.ts` / module | 13 / 11 / 4       | monitored     | `grabAllowed`, `IndexerSearchRequest` Pick, exports                                        |
| client `book/.../tabs/DetailsTab.vue`                                                                    | 191 (30+/161-)    | alignment     | `LinkBookControl` + `useBookProgressRefresh`; upstream read-aloud sync popover removed     |
| `metadata/metadata-extraction.service.ts`                                                                | 12                | ABS           | the extractor seam itself                                                                  |
| client `useLibraryCreator.ts`                                                                            | 12                | ABS           | UI registration                                                                            |
| `book/book.service.ts` / `book.controller.ts`                                                            | 10 / 8            | ABS           | progress emit for file progress; `BULK_COVER_REFRESHER` seam (was 19)                      |
| `authors/authors.module.ts` / `author-enrichment-executor.service.ts`                                    | 9 / 8             | monitored     | export + `allowOrphan` flag                                                                |
| `app.module.ts`                                                                                          | 8                 | all           | module registration                                                                        |
| `notification/notification.service.ts`                                                                   | 34                | web serials   | `groupKey` passthrough and `upsertByGroupKey` (rewrite a group's newest row in place)      |
| `notification/notification.repository.ts`                                                                | 20                | web serials   | `updateLatestByGroupKey`, type taken from `excluded` on the group upsert                   |
| client `notifications/components/NotificationItem.vue`                                                   | 139               | monitored     | release-available icon and the request action on Watchlist release notifications           |
| `packages/types/src/notification.ts`                                                                     | 10                | mixed         | four enum members, two categories and their meta entries (monitored, web serials)          |
| `scripts/migrate.ts`                                                                                     | 2                 | ABS           | pre-migrate row parking call (generic name, no ABS identifiers)                            |
| `scanner/scanner.controller.ts` / `scanner.repository.ts`                                                | 7 / 2             | ABS           | re-extract endpoint                                                                        |
| `achievement-events.service.ts` / `koreader.service.ts`                                                  | 6 / 3             | ABS+alignment | `occurredAt` widening - **propose upstream**                                               |
| `metadata-fetch.module.ts` / `providers/goodreads/goodreads.provider.ts`                                 | 2 / 2             | monitored     | `GoodreadsProvider` exported, `fetchHtml` made public (was a copy)                         |
| `scanner/lib/classify.ts`                                                                                | 1                 | ABS           | `metadata.json` sidecar recognition (was 6)                                                |
| everything else                                                                                          | <= 6 each         | mixed         | enum members, `Record<Union>` exhaustiveness, trivial registrations                        |
| `client/src/locales/*.json`                                                                              | ~60 each          | all           | i18n keys, trivial conflicts                                                               |

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
anchors; a progress-sync listener projects progress across the plain EPUB and the audio files of one
book - gated by a movement
classifier that only trusts an actively-read side (sudden seeks are quarantined until reading
continues from them for two minutes) - and an open-time resolver
returns a precise ebook resume point. Whisper aligns the book's plain EPUB only: `findEbookFile` skips
EPUBs with a media overlay, and `ReadingAlignmentPairService` reports no pair for any book that holds
one (`hasReadAlong`), so nothing builds, resolves or projects whisper there, because upstream's read-aloud sync already joins a read-along to the audio and to
the plain EPUB exactly through its SMIL playlist. Upstream has no analogue for a book without a
read-along, so this is maintained here indefinitely under the same rules as ABS.

**Owned (fork-only) modules - never conflict:** `server/src/modules/reading-alignment/`,
`packages/types/src/reading-alignment.ts` (including the `CrossFormatResume` response),
`server/src/modules/audiobook-chapters/audio-play-order.service.ts`,
`server/src/common/utils/audio-timeline.utils.ts`, and the client feature files
(`features/reader/shared/composables/useCrossFormatResume.ts`,
`features/reader/epub/composables/crossFormatResumeNav.ts`, and the `*Control.vue` components). The
Position sync panel is owned as well, all under `client/src/features/book/`:
`components/detail/tabs/edition-link/` (`chain-ui.ts`, `EditionCover.vue`, `PositionSyncTicks.vue` and
every `SyncChain*.vue`: `SyncChainAbsDetails`, `SyncChainAbsSearch`, `SyncChainActionButton`,
`SyncChainCard`, `SyncChainChevron`, `SyncChainConnector`, `SyncChainGhost`, `SyncChainPanel`,
`SyncChainPlaceholder`, `SyncChainRailSwitch`, `SyncChainReadAloudSlot`, `SyncChainReadAloudStepper`,
`SyncChainRow`, `SyncChainSettingsLink`), `composables/` (`useSyncChainPanel.ts`,
`useSyncChainReadAloud.ts`, `useAudiobookshelfSyncActions.ts`, `useAudiobookshelfSyncLink.ts`,
`useReadingAlignment.ts`) and `lib/` (`sync-chain.ts`, `sync-chain-messages.ts`, `sync-chain-view.ts`,
`read-aloud-defaults.ts`, `abs-sync-status.ts`, `position-sync.ts`). The `edition-link/` folder name and the
`book.detail.editionLink.*` i18n namespace are kept as misnomers; renaming them would only churn.
The trigger shows only when there is something to sync or set up: two of EPUB, read-along and audio,
or Audiobookshelf set up for the book's audio. With a read-along the chain reads ebook, read-along,
audio, joined by upstream's read-aloud sync; without one, ebook and audio are joined by whisper and a
read-aloud slot trails the audio. The slot runs upstream's generator (`useReadAloud`, gated like the
Files tab: `library_generate_read_aloud` and not a demo account) and hides wherever upstream hides its
entry, unless a job is running or failed. Create starts a job in one click with the defaults
upstream's `ReadAloudDialog` would start with (`lib/read-aloud-defaults.ts`) and opens the dialog
instead when no supported language is known; Modify opens the dialog, rendered by `LinkBookControl`
outside the popover; a job shows queued, processing (upstream's steps and percent), review or failed,
and Review opens the Files tab with `?readAloud=details`. A published job reloads the book so the chain
switches to ebook, read-aloud, audio.

**Schema decoupling (same pattern as ABS):** two tables - `audiobook_alignment` and
`audiobook_alignment_anchor` - are applied at runtime by `ReadingAlignmentSchemaBootstrapService`
(`OnApplicationBootstrap`) from SQL embedded in the module's `schema/*-schema.ts`. They are **not** reachable from
`db/schema/index.ts` (drizzle-kit ignores them; `db:generate` reports no changes), use `db.select()`,
and add no migration to `server/src/db/migrations/`. `ReadingAlignmentSchemaBootstrapService` also resets
interrupted `building` rows on boot. `book_edition_links`, `book_edition_read_along_offsets` and the
`storyteller_*` tables stay in existing databases unreferenced; nothing creates or reads them.

**Live ebook projection (fork column `reading_progress.alignment_projected_at`):** when the audiobook
side advances, the sync writes the mapped percentage onto the ebook's `reading_progress` row so every
view of the ebook's progress agrees with the audiobook. It never touches `cfi`, and on update it leaves
`updated_at` and `last_read_at` alone, so the open-time resolver still fires and the reader's Undo still
has its target. A row is a projection while `alignment_projected_at >= last_read_at`; any real read bumps
`last_read_at` through the upstream table's `$onUpdateFn`, so no writer ever clears the column. Per the
fork-column rule it is nullable, added with `ADD COLUMN IF NOT EXISTS` from the module's own bootstrap
SQL, and read or written only through the module-local `pgTable` in
`modules/reading-alignment/schema/reading-progress-projection.schema.ts`.

**Seams / hooks in shared files (keep minimal + generic):**

| Shared file                                             | Hook                                                                                                                                                                                                    | Conflict cost                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `app.module.ts`                                         | register `ReadingAlignmentModule` (the fork registers `AudiobookshelfModule`, `MonitoredModule`, `ReadingAlignmentModule` and `WebSerialsModule`, 8 lines in all)                                       | 2 lines, trivial                                                    |
| `reader/epub/epub.service.ts`                           | `extractSpineText()` added (spine text for matching/backfill); Range/ETag/HEAD streaming of EPUB media through `EpubMediaStreamService` (`epub-media-stream.service.ts`, `epub-zip-range.ts`)           | real; generic methods - keep them generic                           |
| `config/config.ts`                                      | `whisperPath`/`whisperModel`/`ffmpegPath`/`readingAlignment*` on `appConfig`                                                                                                                            | additive                                                            |
| `achievement-events.service.ts` + `koreader.service.ts` | `occurredAt` (effective activity time) on the progress event                                                                                                                                            | **generic, shared with ABS**, additive/removable - propose upstream |
| `packages/types/src/index.ts`                           | `export * from "./reading-alignment"`                                                                                                                                                                   | 1 line, trivial                                                     |
| client `DetailsTab.vue`                                 | `<LinkBookControl>` in the action bar, replacing upstream's read-aloud sync popover (the invite chip stays upstream's); passes `editionProgress`, forwards `saved`                                      | keep additive (do not relocate upstream buttons)                    |
| client `read-aloud/components/ReadAloudJobCard.vue`     | optional `initialDetailsOpen` prop seeding `detailsOpen`, so the panel's Review lands with Details expanded                                                                                             | 2 lines, trivial                                                    |
| client `book/.../tabs/FilesTab.vue`                     | consumes `?readAloud=details` once (like upstream's `readAloud=create`), passes `initial-details-open` to the job card and scrolls it into view                                                         | ~12 lines, additive                                                 |
| client `ReaderView.vue`                                 | open-time `fetchEbookCrossFormatResume(bookId, fileId)`, passed to `useFoliate` as the `crossFormatResume` open option; the server answers only for the aligned plain EPUB of a book with no read-along | one option field, one branch, a `{ crossFormatResumed }` return     |
| `audiobook-chapters/audiobook-chapters.module.ts`       | register and export `AudioPlayOrderService`                                                                                                                                                             | 2 lines, trivial                                                    |
| `book/audiobook-ebook-progress-sync.service.ts`         | `resolveAudioBookPosition` + the `AudioPlayOrderService` injection, feeds the ABS push; `itemDurations` gives a track-boundary clip of unknown length the rest of its section's declared length         | ~30 lines; drop the clip guard once upstream fixes the lookup       |
| client `ReadingLogLedger.vue` / `ReadingLogTab.vue`     | one `audiobookshelf` pill token (ABS); `useBookProgressRefresh` (6 lines)                                                                                                                               | trivial                                                             |
| `Dockerfile`                                            | `whisper-builder` stage compiles whisper.cpp `v1.9.1` (CPU-only, static) -> `whisper-cli`; runtime adds `libstdc++`/`libgomp`                                                                           | isolated stage + one COPY                                           |
| `Dockerfile` + `workers/read-aloud/Dockerfile`          | `npm install -g pnpm@11.28.9` to match `packageManager`; upstream's `11.22.0` tries to switch itself and fails the arm64 build on the unlocked `@pnpm/exe.linux-arm64`                                  | 1 line each; take upstream's pin once it matches `packageManager`   |

**Runtime deps (feature is OFF by default):** `whisper-cli` (bundled) + `ffmpeg` (already present) +
a GGML model, downloaded automatically on first build into `<APP_DATA_PATH>/models` (`WhisperModelService`;
`WHISPER_MODEL` defaults to `base.en`, accepts any whisper.cpp model name or an absolute file path).
Enable with `READING_ALIGNMENT_ENABLED=true`; `WHISPER_PATH` defaults to the bundled binary;
`FFMPEG_PATH` defaults to `ffmpeg`. See `.env.example`.

**Plugin removal:** unregister `ReadingAlignmentModule` in `app.module.ts`. The app still builds and
runs: the resolver route 404s and the client falls back to its normal saved-position restore; the
progress-sync listener simply isn't registered; the Position sync panel still shows its ABS and
read-aloud rows, and only the whisper connector shows "Not aligned" with no backend (the status route
404s). The fork Vue component files must remain for the client to compile (expected UI-registration
coupling). The two tables are left in place, unused.

**Watched cross-module import:** `audiobookshelf-match.utils.ts` (ABS) imports the pure helpers
`applyPathMappings`/`pathMatchesPrefix` (and the `PathMapping` type) from upstream's `migration/planner/`
for the path-mapping match tier, rather than reimplementing it. Signature drift (a rename, a moved file, a
changed parameter) breaks it at typecheck; behaviour drift that keeps the signature is caught by the
upstream-contract tests in `audiobookshelf-upstream-contract.test.ts`, which pin the no-match passthrough,
longest-source-prefix ordering, the skipping of a prefix that normalizes to empty, and
`pathMatchesPrefix`'s trailing-slash handling. Re-point or inline the two functions if they move.
Audio-format predicates in ABS and `reading-alignment` come from
`@bookorbit/types` (`AUDIO_FORMAT_LIST` / `isAudioFormat`), not from `scanner/lib/classify.ts`.

**Audio play order must match upstream's manifest.** Every consumer of an absolute audio position
(the ABS push through `resolveAudioBookPosition`, and the whisper build, resolve, sync and pair
services through `reading-alignment.repository.ts`) gets the clock from the fork-only
`AudioPlayOrderService` (`audiobook-chapters/audio-play-order.service.ts`). It orders tracks with
upstream's `orderAudiobookTracks`, resolves stored chapters with `resolveStoredAudiobookChapters` and
snaps rounded file boundaries onto chapter starts with `snapAudioFileStarts`
(`common/utils/audio-timeline.utils.ts`); `buildAudioTimeline` consumes the result. A divergent order
or start silently writes wrong percentages. A snapped start is part of the alignment content hash, so
a book whose boundaries move is rebuilt; starts that match the summed durations are left out of the
hash, so alignments built before snapping stay fresh. The projection's percentage divides by the sum
of file durations (upstream's player prefers `book_metadata.duration_seconds`); they differ only when
that column is overridden.

**Merge notes:** the progress-sync projection into reading-state is the irreducible core coupling (like
ABS). `extractSpineText` on `epub.service.ts` is the one seam worth watching on an upstream EPUB
refactor. The `occurredAt` widening is shared with ABS - resolve it once. The `BOOK_PROGRESS_CHANGED`
emit in the ABS pull is ordered after upstream's `syncEbookProgressForAudiobookPlayback`, like
`audiobook.service.ts`.

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

**Background eligibility.** Every background path that can submit a request on an owner's behalf
(the fetch job, fetch-event items, follow-ups, the release watcher and its recheck before fan-out,
and `fanOut` itself) checks `isEligibleMonitoredUser` (`monitored/monitored-user.utils.ts`): the owner
is active and is a superuser or holds `BookRequestAccess`. The owner is reloaded where a step runs
later, so a permission revoked between announce and fan-out stops the request. The only ungated
submitters are the controller routes, which carry `@RequirePermission(Permission.BookRequestAccess)`.

## Web Serials overlay

The fork carries a Web Serials overlay: manga and web-novel engines fetch serials chapter by chapter
and import them as CBZ or EPUB volumes. **Owned (fork-only) code - never conflicts:**
`server/src/modules/web-serials/` (engines, lookup, schema bootstrap in `web-serials-schema.ts`),
`client/src/features/web-serials/` and `packages/types/src/web-serials.ts`. Its upstream footprint is
the module registration in `app.module.ts`, the notification group-key upsert and the notification
enum members (see the conflict table).

- **Per-user quota lock.** `WebSerialsRepository.withUserJobQuota` takes a transaction-scoped advisory
  lock per user, runs the write, then recounts and rolls back when the user is over the limit, so two
  concurrent creates or resumes cannot both pass the check. Resume passes `countActiveJobs` as the
  counter.
- **Scoped move-to-top.** `moveJobToTop` reorders globally for superusers and `ManageAppSettings`
  holders and only among the owner's own queued jobs otherwise. The job response carries
  `canMoveToTop` from the same scope, so the client never offers a move that would change nothing.

**Plugin removal:** unregister `WebSerialsModule` in `app.module.ts`; its tables stay in place, unused.

## Storyteller read-along overlay (removed 2026-10-28, upstream v3.6.0 merge)

The fork used to carry a fourth overlay that drove an external Storyteller server to build read-along
EPUB3s and imported each one as a separate book attached to an edition link as its read-along member.
Upstream v3.6.0 ships in-app read-aloud generation (`workers/read-aloud`, STAlign + QuartzNet, which
publishes `<book>.readaloud.epub` into the book's own folder; see [`docs/READ_ALOUD.md`](docs/READ_ALOUD.md)),
so the overlay was deleted in that merge rather than carried.

Removed: `server/src/modules/storyteller/`, `client/src/features/storyteller/`,
`packages/types/src/storyteller.ts`, `docs/STORYTELLER_READ_ALONG.md`, `common/utils/path-prefix-mapping.utils.ts`,
the `STORYTELLER_*` env vars, the settings tab, route and nav entry, the read-along build UI in the
Position sync panel, the `READ_ALONG_OUTPUT_SOURCE` seam in `edition-link/` and the
`READ_ALONG_PROVENANCE_SOURCE` seam in `book/` (and the Storyteller file-name chapter matching it enabled),
and the notification `meta.locked` / progress / cancel-build support that only builds used.

Removed later, with edition links on 2026-10-29/30: the edition link's read-along member and the
manual read-along attach route (`GET/POST/DELETE /edition-links/*` are gone), `read-along-chapter-mapping.ts`,
and `mp4-faststart.ts` (the Storyteller-format moov-after-mdat rewrite). EPUB media is still streamed
with Range/ETag through `epub-media-stream.service.ts` / `epub-zip-range.ts`, unchanged. The
`storyteller_settings`, `storyteller_read_along_builds`, `book_edition_links` and
`book_edition_read_along_offsets` tables stay in the database unused; nothing reads them.

## Read-along narration player overlay (fifth permanent feature)

The fork carries a **fifth** overlay: the player for EPUB3 media-overlay narration (read-along books:
upstream's read-aloud output or Storyteller-built EPUBs). Upstream shows `MediaOverlayMiniPlayer`, a 480px bar at the bottom of the
reader that covers the text. The fork replaces it with a small floating **pill** (play/pause and an
"open controls" button) that expands into a **full player** (cover, title, chapter dropdown, speed,
previous/next sentence, sleep timer with an end-of-chapter option). When the reader has moved away from
the narrated sentence, "Back to narration" and "Narrate from here" chips sit beside the pill. A
"Listen with narration" chip above the reader footer starts narration. Narration itself still runs
through upstream's `useMediaOverlay.ts`; the sleep-timer carry-over across restarts is done with
watchers. Since the 2026-10-13 background-playback work the fork does edit that composable (one
playlist timeline, a resume snapshot, background playback: 435 semantic lines on 2026-10-30), so it is
now this overlay's largest upstream hunk and the first file to check on an upstream narration change. Upstream's `MediaOverlayMiniPlayer.vue` is left in place,
unused, so upstream changes to it merge cleanly.

**Owned (fork-only) code - never conflicts:** everything under
`client/src/features/reader/media-overlay/` that upstream does not ship:
`components/MediaOverlayDock.vue` (+ `.test.ts`), `components/MediaOverlayFullPlayer.vue`
(+ `.test.ts`), `components/MediaOverlayDetachedChips.vue`, `components/MediaOverlayStartButton.vue`
(+ `.test.ts`), `composables/useNarrationChapters.ts` (+ `.test.ts`),
`composables/useNarrationSleep.ts` (+ `.test.ts`) and `composables/useNarrationDockPosition.ts`.

**Seams / hooks in shared files (keep minimal + generic):**

| Shared file      | Hook                                                                                                                                                                                                                       | Conflict cost     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `App.vue`        | import and render `MediaOverlayDock` in place of `MediaOverlayMiniPlayer`                                                                                                                                                  | 2 lines, trivial  |
| `ReaderView.vue` | `MediaOverlayStartButton` import and render, the `showNarrationStart` computed, `registerNarrationChapters` import and its registration wrapped in `onUnmounted`, `sectionHasMediaOverlay` in the `useFoliate` destructure | additive          |
| `useFoliate.ts`  | `sectionHasMediaOverlay` on the returned API + the `sections` field on the view's `book` type                                                                                                                              | 2 lines, additive |
| `en.json`        | `reader.narration.*` additions                                                                                                                                                                                             | additive, en-only |

**Plugin removal:** in `App.vue`, swap the `MediaOverlayDock` import and render back to
`MediaOverlayMiniPlayer`. In `ReaderView.vue`, drop the `MediaOverlayStartButton` import and render,
the `showNarrationStart` computed, the `registerNarrationChapters` import and the `onUnmounted`
registration, and `sectionHasMediaOverlay` from the `useFoliate` destructure. In `useFoliate.ts`, drop
`sectionHasMediaOverlay` and the `sections` type field. Then delete the fork-only files listed above.
The unused `reader.narration.*` keys in `en.json` can go too; nothing else reads them. Restore
`useMediaOverlay.ts` from upstream as well; upstream's bar then works as before.

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
  ABS matching. Its `normalizeIsbn` was deleted on 2026-10-30 in favour of upstream's
  `text-match/isbn-normalize.ts` `normalizeMetadataIsbn`. `hardcover-import.service.ts` is byte-identical to
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
- **Upstream `AudiobookEbookProgressSyncService` vs the alignment overlay** (re-checked 2026-10-30,
  after the same-record switch). Both now work inside one book. Upstream maps audio through the
  read-along's SMIL playlist, refuses pairs whose durations differ by more than 5%, and writes every
  EPUB of the book (the read-along first, then plain copies, with a full CFI). The whisper overlay
  aligns the plain EPUB with no overlay and writes percentage-only projections. When a book has both,
  they would target the same plain-EPUB row, so the pair service reports no whisper pair for any book
  that holds a media-overlay EPUB, whatever its read-aloud sync mode, and the resolver
  also returns nothing when the opened file is not the aligned plain EPUB. Upstream's exact mapping
  owns every book with a read-along. **Not substitutable:** whisper exists for books with no
  read-along at all.
- **Upstream `TtsTextExtractorService` vs `EpubService.extractSpineText`** (checked at the v3.0.0
  merge). Upstream's extractor serves one chapter per call (it reopens the zip each time), is not
  exported from `TtsModule`, and splits text with `htmlToBlocks`, whereas alignment matching reads
  the whole spine in one pass through `extractVisibleText`. Swapping normalizers would shift every
  stored anchor. **Not substitutable; the seam stays.**

## Where the remaining work is

Re-measured 2026-10-30 on the v3.6.0 merge tree (`git diff -w --numstat --diff-filter=M upstream/main`,
locales, docs, JSON and tests excluded): modified upstream source files carry 9359 semantic lines
across 192 files for all overlays (2026-09-16: 1607 across 80 for three). The growth is mostly the
book-request work (Shelfmark, batch grab, release inspection), the command palette and the narration
player, not seams: four seams remain after the two edition-link seams were deleted. The largest are
the vendored `client/public/assets/foliate/epub.js` (671), `request-fulfillment.service.ts` (441),
`useMediaOverlay.ts` (435) and `request-import.service.ts` (402). Of the overlay hooks this document
tracks, `scanner.service.ts` (324, Phase B, fork-internal shrink only) and `metadata.service.ts` (149,
cover precedence) are still the largest; the monitored Hardcover client additions (231 + 126 types)
come next and are generic GraphQL.
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
- ABS pull: it calls `syncEbookProgressForAudiobookPlayback` and emits `book:progress-changed`, the
  same pair upstream's player does; if upstream ever emits from `putPlaybackState`, both fork emits
  can go.
