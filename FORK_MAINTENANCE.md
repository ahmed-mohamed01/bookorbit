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

5. **When upstream cannot replace fork code, adopt its method.** Replace and wrap are not the only
   outcomes. If upstream ships a better way of doing a job the fork also does (an index built once
   instead of a reopen per call, one query instead of a fan-out, a cache, batching, bounded
   concurrency, a cheaper rendering or animation technique) but taking upstream's code outright would
   lose fork behaviour, keep the fork feature and port the **technique** into the fork's own function.
   Example: if upstream moves an animation to a cheaper shader method and the fork has its own
   animations, the fork animations stay and are rewritten on upstream's method; they are not dropped
   for upstream's, and not left on the old method. Rules for an adoption:
   - Weigh it first. Name what upstream's method saves (queries, file opens, allocations, renders)
     and where the fork runs the old one. "Upstream did it differently" is not a reason.
   - Call upstream's primitive when it is exported (helper, service, composable, index). Copy the
     approach only when there is nothing to call, and say so in the merge log so the next merge
     re-checks it.
   - The fork behaviour is the contract. Same outputs and edge cases before and after, proven by the
     fork's existing tests and a live run, not by the port compiling.
   - The change lands in fork-owned files. An adoption that adds lines to an upstream file fails the
     footprint test in "Guiding principle" like any other hook.
   - Every upstream merge gets an explicit verdict per overlapping upstream change, recorded in the
     merge log: **replace** (rule 2), **wrap** (rule 4), **adopt the method** (this rule), or **keep**
     with the concrete difference stated.

6. **Deliberate code-moves are not duplication.** Extracting upstream code verbatim into a fork-only
   file for reuse (e.g. `fuzzy-match.utils.ts`) is the sanctioned way to share upstream logic without
   inverting layering - do not flag it as duplication, but honour its merge hazard note.

7. **Plugin isolation is a review gate, not a nicety.** A fork feature must be removable: with its
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

## Enforcement

Git hooks hold every commit to this document, for people and agents alike. They live in
`.husky/fork/` and run from the hooks husky already installs.

- **Docs** (pre-commit, `docs.sh`): a commit that changes a file upstream owns (present in
  `upstream/main` or at the last merge base) must also change this file. Record the change in
  the overlay's section, and in the conflict surface table when a hook grew. In a merge, only
  files that differ from both sides count.
- **Surface** (commit-msg, `surface.sh`): a commit may grow the fork's lines in upstream files
  by at most 20, measured with `git diff -w` against the merge base. Past that, move the logic
  into fork-owned files, or add a `Fork-Surface: <why it has to live there>` line to the message.
- **Merge log** (pre-commit and pre-merge-commit, `merge-log.sh`): a merge that brings in
  upstream commits must add an entry under "Merge log". A merge that would commit on its own
  stops instead; add the entry, stage this file, and run `git commit`.
- **Agents** (`.claude/hooks/git-guard.sh`): Claude Code may not run `--no-verify`,
  `commit -n`, `HUSKY=0`, `FORK_DOCS_SKIP=1`, or change `core.hooksPath`. Codex and other agents
  follow the same rule from `AGENTS.md`.

`FORK_DOCS_SKIP=1` skips the docs check once, for the user only. Worktrees whose
`core.hooksPath` points at this checkout's `.husky/_` run the checks from this checkout, so a
branch cannot weaken them. Without an `upstream` remote the checks pass.

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
re-resolving around it. The merge is the moment to shrink the fork, not just re-carry it. Before
resolving, list the incoming commits and give each one that overlaps a fork feature a verdict
(replace, wrap, adopt the method, keep) per rule 5 there; where upstream's way is more efficient but
cannot replace the fork feature, port the method into the fork's function in the same merge.

**Migrations no longer need any merge step.** `server/src/db/migrations/` is
byte-identical to upstream (see "Schema decoupling"), so upstream migrations flow in
untouched and `_journal.json` can no longer collide.

Known pre-existing upstream failures (**not** caused by the fork): the
`published-date.utils` timezone bug, which also fails `kobo.scraper.test.ts`; and since
`acce1e15`, `SettingsNav.spec.ts` / `SettingsSidebar.spec.ts` (upstream's `SettingsNav.vue` now
reaches the real router through `useBookRequestVisibility` -> `useAuth`, and its `vue-router` mock
has no `createRouter`); and since `4881f1f5a`, an unhandled `refreshLibraries is not a function` from
`AuthorDetailView.spec.ts` (upstream's `useDeleteBook` now calls `useLibraryCountsRefresh`, which its
`useLibraries` mock lacks), so client vitest exits 1 with every test passing. Don't chase these during
a merge.

Fork-caused spec drift, which **is** ours to fix at merge time: upstream specs that count
the permission catalog (`UserFormDrawer.spec.ts` expects one more than upstream because of
`audiobookshelf_sync`) and fork spec fixtures that hand-build upstream types
(`MonitoredBookPanel.spec.ts` builds a `ReleaseCandidateItem`; a new required upstream field
breaks it). Each is a one-line catch-up; make it rather than carry a red test.

### Merge log

- **2026-11-24, upstream `6905a755e`, 43 commits.** 23 conflicted files. Upstream groups linked books as
  editions of one work (`book_links`, edition strip and table, "Formats" card heading, per-work counts
  through `workKeySql`, an "Other editions" duplicate scan, migration 0162 with `edition_name` and
  `original_published_year`), idles background workers behind `IdlePoll`, opens cards, rows and tiles in
  a new tab (`ActivateLink`, `useOpenInNewTab`), moves the read-aloud worker to the `@storyteller/*`
  packages, splits scan Phase 3 into `readRegisteredMetadata` for the OPDS file repair, emits
  `audiobook.progress-changed` for StoryGraph and estimates audiobook progress while a track is
  unmeasured. Migration 0162 widens three upstream `*_kind_chk` CHECKs and touches no fork CHECK or
  bootstrap SQL (no parking). Verdicts per "Reviewing changes" rule 5:
  - **Replace.** `server/bin/kepubify/*`: upstream's rebuild is byte-identical to the fork's Go 1.27.4
    binaries, so the divergence and its "Propose upstream" entry are gone. `audiobook.module.ts` is
    upstream's again (it now imports `AchievementModule` itself); `audiobook.service.ts` takes upstream's
    required `AchievementEventsService` and drops the fork's `@Optional()`.
  - **Keep.** The fork's `book.progress-changed` emit from `putPlaybackState` stays beside upstream's
    narrower `audiobook.progress-changed` (`{ userId, bookId }`, StoryGraph only): alignment needs
    `bookFileId`, and the ABS push, Hardcover, achievements and `scan.gateway` listen to the fork event.
    `AUDIO_POSITION_DERIVED` in `saveAudioProgress` stays too, since upstream emits only when the rounded
    percentage changes. Upstream's unmeasured-track estimate (capped at 99) is not adopted by the
    whisper projection or the ABS push, which need exact seconds, and the fork emit fires only on a
    measured percentage (`measured && isStoredPercentageChanged`), as it did before the merge, when an
    unmeasured book kept its previous figure; otherwise Hardcover would be sent a guess. The editions grouping is the complement of the
    same-record model, not a replacement: formats stay in one record, separate editions use upstream's
    links, which the fork never removed. No fork module reads `book_links`.
  - **Merge hazards fixed.** `workers/read-aloud/src/rebuild.ts`, `rebuild-metadata.ts` and
    `test/rebuild.test.mjs` resolve `@storyteller/align` and, through it, `@storyteller/epub` (and its
    yazl, yauzl-promise and xmldom); the old names would have failed at module load. The Watchlist
    Amazon probe calls `amazonRequestHeaders(cookie)` after upstream dropped the referer argument. In
    `scanner.service.ts` the fork code git carried into `readRegisteredMetadata` needs `organizationMode`,
    a required parameter placed before upstream's optional `regexContext`; upstream's OPDS repair
    (`refreshRegisteredFile`) passes the library's mode with one added line, so the repair selects
    sources exactly as a scan does. Leaving the providers out of the repair was tried and rejected in
    review: it promotes `embedded` to the leading source, so a changed EPUB overwrote metadata.json
    fields (authors, genres, series) and the new file stamp then hid it from later scans. With the
    providers in, an unchanged sidecar is never flagged changed, so the repair reads nothing a scan of
    the same change would not, with one difference: upstream's repair flags a file changed on an
    inode-only replacement (same size and mtime) where a scan would not, so a regex library may re-read
    an unchanged metadata.json or re-import an unchanged cover.jpg. That is idempotent. In a regex
    library an unreadable metadata.json falls through to the EPUB, as it does on a scan.
    `importProvidedCover` takes `{ id, primaryFileId? }`. The batch retry (`book-request-batch.service.ts`) and the
    batch hold (`request-batch-import.service.ts`) emit `BOOK_REQUEST_DOWNLOAD_QUEUED`, because the
    download monitor now idles at 60 s until woken; upstream's own emit already sits in the fork's
    shared `handOff`, so batch grabs wake it too. The command palette keeps the fork's `select()` and
    takes upstream's click, aux-click and Ctrl/Cmd+Enter handling; the location mapping moved into
    `itemLocation` in `useCommandPaletteResults.ts`, which `activate` also uses, so Watchlist, web serial
    and Hardcover rows open in a new tab as well. Crowdin re-added the fork-removed `readAloudSync` keys
    to hu/ru; they were dropped again (this recurs every sync).
  - **Latent, recorded.** `0100b9037` holds an older edition filed against a newer edition's request
    by ISBN and year; fork batch rows and Watchlist requests carry no ISBN, so it cannot fire today.
    If batch rows ever carry ISBN and year, null them in the `batch-unit-filing.service.ts` call.
    `3c9c0e8db` now rewrites cover-page geometry on cover replacement, still inside the edition sync
    "metadata-only" contract (image-only pages fingerprint as empty text). Audio conversion's
    `requestMetadataFetch` inserts into the metadata queue without the orchestrator's wake, so that step
    can wait up to 60 s more; upstream exports no public wake. A batch retry that lands within 15 s of
    the monitor's last resume sweep waits up to 60 s even though it emits the wake (the sweep window is
    skipped, `completed` is not an active status, and the poll backs off); no data is lost, and fixing it
    needs either a one-line upstream edit in `onDownloadQueued` or a fork-side status change, so it is
    deferred. Upstream now stores the unmeasured estimate in `audiobook_progress.percentage`, and two fork
    readers still read that column: the ABS pull's first comparison (`syncedProgressAt` null, push off)
    can skip one newer remote position against a stale estimate (deferred: compare on the measured
    timeline), and the alignment projection decided "finished" from the stored percentage. The live run
    showed Kobo sync reads a projected 100% as Finished, so that one is fixed here: `projectAudioToEbook`
    measures the position against the file timeline and trusts the stored percentage only above 99,
    which an estimate can never reach (`UPSTREAM_ESTIMATE_CEILING` mirrors upstream's private
    `ESTIMATED_PERCENTAGE_CEILING`; a test reads `audiobook.service.ts` and fails if upstream changes
    it). A read status is not used: under the same-record model it is shared with the ebook, so a
    relisten of a read book would trust a stale estimate. KOReader never sends a finished status. The
    fork's `audio-convert.utils.test.ts` stall test ("faststart pass") is timing-flaky (about 1 run in
    3 in isolation); `audio-convert/` is untouched by this merge.
    Also deferred: an estimate followed by an equal measured figure emits no fork event.
  - **Follow-ups (each its own change, live-tested).** Rule 5 asks for adoptions in the same merge;
    these are deferred because each needs wake wiring and its own live run: adopt `IdlePoll` in `audio-convert-queue` (2 s) and `web-serials-job-runner` (3 s); audit fork
    counts that sit beside upstream's per-work counts; `ActivateLink` on Watchlist author and work
    cards; `description-content` in `BookSynopsis.vue`; the mobile no-zoom rule on fork search inputs
    and `MonitoredVirtualGrid.vue`; rename the edition sync "Sync # editions" copy to formats; the batch
    retry wake above; a public metadata-queue wake for audio conversion. Done in this merge instead: the
    Watchlist local author search and its monitor-modal fallback count works (`workCount ?? bookCount`),
    so linked editions no longer count twice, and the palette's fork rows have `itemLocation` and
    new-tab tests.
  - Fork spec drift: `CommandPalette.spec.ts` (`itemLocation` mock), `NeglectedGemsWidget` and
    `HighlightOfTheDayWidget` specs (`RouterLinkStub`), `BookEditionsCard.spec.ts` ("Formats"),
    `DetailsTab.audioConvert.spec.ts` (`useDeleteBook` editions), `AuthorTile.spec.ts` and three
    `BookCoverCard.spec.ts` cases that now hover first, as the fork card mounts its controls on hover.
    Upstream's own `AuthorDetailView.spec.ts` prints an unhandled `refreshLibraries is not a function`
    (its `useLibraries` mock predates `useLibraryCountsRefresh`); not ours.
- **2026-11-19, upstream v3.9.0 + 9 (`c1dd6b4f1`), 40 commits.** 55 conflicted files. Upstream added AI
  providers, story guides and photo scans; a Jobs area (`JobSourceRegistry`, `JobChangesService`, the
  `/jobs` socket, `bulk_runs`); a rebuilt request drawer, release picker and request list with views,
  search and bulk actions; per-library docks and the "Library Dock" name; stored read-along timelines
  and a timeline built from the audio a clip reaches; worker path mapping; a `display` cover variant;
  per-user hidden libraries; genre and tag pages; and name-key expression indexes. Migrations 0145 to
  0161 touch no fork CHECK constraint (no parking). Verdicts per "Reviewing changes" rule 5:
  - **Replace.** `ssrf.utils.ts` is upstream's again (fork `isLinkLocalAddress` deleted, the self-hosted
    URL check uses `isLinkLocalOrMetadataAddress` and throws `LinkLocalAddressException`). The cover
    stack and tint use upstream's `display` variant. The `main.ts` PDF prefetch went (upstream's
    `prefetchPdfReader`; the fork's imported a package upstream removed). `BookReadingActivityCard.vue`
    is upstream's. The request list column and overflow hunks went for upstream's `colgroup`.
    `seriesMembershipsFromForm` went for upstream's server-side `withPrimarySeries`.
    `RequestRowActions.vue`, `RequestDownloadProgress.vue` and `pairRowActions` are deleted with upstream.
  - **Wrap.** The track-boundary clip guard is now `clockItems`, an adapter that feeds the
    `itemDurations` clock to upstream's `locateItemByNarratedSeconds`, `timelineSecondsToNarratedSeconds`
    and `narratedSecondsToTimelineSeconds` (upstream's lookup still treats an unknown-length clip as
    open-ended). An unreadable download keeps the fork's two-path message and `readdir` check, thrown as
    upstream's `ClassifiedImportError` `DOWNLOAD_UNREADABLE` with `meta.path`, from the batch import too.
    The bulk cover re-extract runs as upstream's bulk run; `BULK_COVER_REFRESHER` gained an optional
    `prepareBulkRun` hook that `BookReExtractCoverBulkHandler` calls (8 lines added, 6 removed in
    `book-bulk-run-handlers.ts`), and the ABS service answers with upstream's `locked` / `no-source`
    outcomes and enqueues the cover reconciler. `useAppInfo.ts` is upstream's plus one line
    (`loaded` stays false while the update check is unresolved, because the fork answers before the
    check finishes).
  - **Adopt the method.** The "never grab a batch" rule is one condition in upstream's
    `actionReaches('pick')` (`requestSelection.ts`), with `kind` on `BookRequestSelectionEntry` filled by
    `selectMatching` from `batches.findKinds`, replacing three scattered checks. `findPortraitCandidates`
    matches through `normalizeMetadataTextKeySql` and so uses `authors_name_normalized_key_idx`
    (`findIdByNormalizedName` does not: the indexed key can pick a different author than the
    punctuation-insensitive match, e.g. "JRR Tolkien" vs "J.R.R. Tolkien"). Edition sync's admin status
    reads `lastKnownHealthState()`; gating calls keep a fresh probe. Every fork long-running job registers as a Jobs source
    (`*-job-source.ts`, `*-job-page.repository.ts`, bootstrap indexes) and the fork pages follow the
    Jobs push through fork `followJobType`, with upstream's 15 s fallback only while the socket is down,
    in place of their 2 to 10 s polls: Web Serials downloads (`web-serial`), Convert to M4B
    (`audio-convert`, automatic conversions read as ownerless), edition sync index builds
    (`edition-sync`: one row per book, pinned books in claim order ranked over what the viewer can
    see, one backlog summary row as upstream's metadata queue does, Cancel only for the book being
    built), Watchlist updates (`watchlist-fetch`: the latest fetch per monitored author, owner-only,
    from the existing `fetch_state` columns plus nullable `fetch_queued_at` / `fetch_started_at`;
    state notifies are folded to one per owner per 10 s because upstream's gateway sends state events
    to the whole type room), the cover thumbnail backfill (`cover-thumbnail-backfill`, one row, Cancel
    stops the run and leaves the switch alone), Audiobookshelf sync (`audiobookshelf-sync`: the
    running run from memory plus the last full, reconcile or poll outcome from nullable
    `last_run_finished_at` / `last_run_kind` / `last_run_error`, which the 30 s hot tier never writes)
    and Whisper alignment builds (`whisper-alignment`, unalignable books settle in History and Retry
    runs only when files or settings changed). A batch download keeps upstream's `request-download`
    row: the optional `REQUEST_DOWNLOAD_JOB_DECORATOR` (3 lines added, 2 changed in
    `request-download-job-source.ts`, 3 in `book-request.module.ts`) lets
    `BatchDownloadJobDecorator` set kind `batch`, a `batch-downloading` phase, and "N of M in Library
    Dock" during the import. `packages/types/src/jobs.ts` gained 11 lines (7 job types, 4 view
    permissions; each source checks its own permission, so a view permission opens no other type).
  - **Keep.** Thumbnails stay on the fork's baseline options: upstream's `mozjpeg: true` is
    progressive, which upstream #782 found some OPDS clients cannot decode. Local work folders stay
    beside upstream's `READ_ALOUD_PATH_MAP` (both translations apply once; scratch is upstream's tmp
    folder). The picker keeps streamed search, ranking overrides, background inspection, the origin
    chip and batch grab; the drawer keeps batch units, batch import retry and the Shelfmark chip rules
    (now in `releaseMeta`); the list keeps batch rows. The Watchlist badge, the `#tabs` slot and
    `canFold` (now counting upstream's `#below` strip), the placeholder toggle, and the
    `BOOK_DOCK_BOOKS_FILED` emit stay. Fork queries (Watchlist ownership, edition sync, ABS) do not
    honour hidden libraries. `findFaceRows` computes `primaryFormat` and upstream's new
    `primaryReadAlong` in JS from the fork's format-priority ranking, not upstream's SQL join.
    Merge hazards fixed: `hasUpstreamActiveJobs` counts a queued read-aloud job only when upstream could
    claim it now (not paused, not cancel-requested, `next_attempt_at` reached; upstream 0153 `paused_at`
    would have made edition sync yield forever); the batch import rechecks its claim after a filename
    collision and before marking the attempt imported, `settleAvailable` fails in-flight attempts like
    upstream's manual fulfilment, and a batch retry clears `failureCode`; the batch import writes
    `failureCode: 'removed'` like the single import; `setupOverview.requests.kinds.shelfmark` exists;
    the Watchlist settings entry sits directly above Requests again (upstream's Setup entry landed
    between). One upstream bug is patched in passing at the owner's request: the list row passes its cover ratio to the artwork (see "Propose upstream"). Fork spec drift: `placeholder` in `audio-cover-embed.spec.ts`, `decidedByName` and
    `primaryReadAlong` in fork fixtures, `scratchDir` in the worker rebuild test, the scanner
    provider-cover test moved onto `makeService` (its positional args had shifted again and it would
    have passed vacuously), and the command-palette "all" count (upstream's Library Dock settings
    keywords now match "final"). `pnpm-lock.yaml` was rebuilt from upstream's (the textual merge was
    broken). Surface: 271 modified upstream source files, 10,613 semantic lines (was 271 / 10,603; 10,595 before the Jobs hooks).
    Verified: `verify:fast` green, server 26,524, client 12,160 and worker 150 tests green, and a production client build. Live run on a
    copy of the dev database (`bookorbit_merge`, outbound integrations blanked): migrations 0145 to 0161
    applied, the server booted with every fork bootstrap column and index created, all 18 job types
    answered in every view and scope, queue paging returned each row once in order, the `/jobs` socket
    pushed a fork type's change, and 248 of 314 callable GET routes returned 2xx with no merge-caused
    5xx. The live run found one bug every SQL-text test had passed: the Whisper alignment queue ordered
    by a bare `0`, which PostgreSQL reads as a select-list position, so the whole Jobs Queue view
    returned 500 (now `0::integer`). Not exercised live: the bulk cover run against an Audiobookshelf
    library, real downloads and imports, a real index build, and the client in a browser.
    A five-area Opus review of the whole fork followed, before the commit. Fixed in the merge: the ABS
    bootstrap no longer drops `bm_audible_id_idx` (upstream's migration 0158 now creates an index of that
    name; the fork had dropped its own old one by that name on every boot since August) and restores it
    only where a sibling index proves 0158 ran; the Whisper progress listener returns at once when the
    feature is off and probes for a ready alignment before doing any other work; a failing Web Serials
    job (and CBZ finalization) can no longer leave an unhandled rejection that exits the process; a Web
    Serials job move takes the per-user quota lock; the unread Web Serials heartbeat writes are gone (the
    column stays); a batch request is refused up front when its request has no destination library;
    the reader's `cancelScheduled()` clears its timer handle, so narration saves resume; and the ABS
    settings are re-read past the cache after a sync, rescan or clean-up. Deferred from that review, each
    as its own change: batch imports send none of upstream's notifications (`failDownload`,
    `notifyBookAvailable`) and leave `importedAt` unset; the Watchlist's `findIdByNormalizedName` ignores
    accents and disagrees with the fork's two other author keys (fix the key, then index it from the
    monitored bootstrap); narration chapters are one global slot any open reader overwrites; the sidebar
    Watchlist badge is fetched once and survives a sign-out; the Watchlist release stream is not aborted
    on leaving a work; the ABS pull maps positions with its own track order, not `AudioPlayOrderService`;
    release checks and catalog syncs are capped at fixed hourly batches; the command-palette title
    prefilter has no minimum length; `findFaceRows` loads every file row of a page's books; Convert to
    M4B's stall timer resets on any ffmpeg output (upstream counts only real progress) and its
    reference moving could use upstream's `retireFile`; the ABS client could connect through pinned
    `safeFetch`; `epub-zip-range.ts` duplicates upstream's `openEpubZipEntryRange`; several fork API
    wrappers could sit on upstream's `ApiError`; the Watchlist views could use `useCoalescedRefresh` and
    virtualized rows; four unused `monitored.*` strings, the revived `MediaScrubber.vue` extras, the
    uncalled `/monitored/books*` routes and a few unread returns are dead; and Web Serials admin install
    routes accept API keys while batch requests skip the self-serve cap (owner decisions). Known
    leftovers: a Jobs cancel on a batch download cancels the whole batch request; no fork job type offers `dismiss` in Jobs; the Jobs cancel confirmation is generic, so stopping an index build (which ends the whole run) and cancelling a batch download (which cancels the batch request) are not spelled out there (a per-row description would take 5 lines in upstream's `JobsActivityView.vue`); Watchlist and Audiobookshelf state events still reach every viewer of the type (an owner-scoped state option would take about 10 lines in upstream's `jobs.gateway.ts`); a Postgres trigger turns failed index rows stale without a Jobs notify; each Retry from Jobs recomputes the edition sync queue position; a request with auto-grab off is not counted in upstream's "awaiting manual
    pick" view; the reader's narration handoff waits at most 5 s for the book fetch; `ensureAppInfo`
    refetches on each call while the update check never resolves; a paused queued read-aloud job reads
    "Queued" in the fork's read-aloud row; `EpubService.extractSpineText` still buffers a spine
    document with no size bound (upstream's `BOOK_TEXT_LIMITS` could be adopted); the ABS client and the Web Serials engine fetches do not pin the resolved address (`safeFetch` `pinResolvedAddress`).

- **2026-11-14, upstream v3.8.0 + 6 (`c77966cc5`), 18 commits.** 17 conflicted files. Upstream added
  API keys (`api_keys`, `ApiKeyPolicyGuard`, `@InteractiveOnly` / `@KeyReadSafe`, `principalCacheKey`)
  and routed every requester library decision through `LibraryScopeService`; the TorBox cloud client
  (local staging, `stagedClientDir`); removal of finished usenet jobs after import; keeping finished
  torrents seeding when a request settles; named KOReader devices on sessions and highlights; ISBN
  candidates read from a book's text; and a concurrent scanner (`registerCandidate` +
  `readCandidateFiles` under `pipelineWithConcurrency`, audio lengths read in-process).
  Shelfmark and TorBox coexist in every `DownloadClientType` map (Shelfmark stages nothing, never
  deletes remote, never removes completed); upstream's generic apiKey check replaced the fork's
  Shelfmark credential branch. `download-removal.service.ts` runs the fork's shared/extended-torrent
  rule, then upstream's `keepsSeed`, then `detach`; an explicit `removeAttempt` applies only the
  shared rule, as upstream lets an operator remove a finished torrent; `cleanupStagedClientDownload`
  keeps a staged copy another unsettled attempt shares (`existsOtherForClientKey` gained a
  `statuses` argument). The scanner threads `reextractMetadata` into `registerCandidate` and
  `organizationMode` into `readCandidateFiles`, keeps the `processCandidate` wrapper for the fork's
  call sites, and keeps `!selfWriteInProgress` on upstream's new audio probe block. `auth.service.ts`
  keeps the parallel session/user lookup and returns upstream's `credential`. The read-aloud worker
  `Dockerfile` is upstream's again (same Debian upgrade fix as `be24a4255`).
  API-key adaptation of fork code: `LibraryService.verifyUserAccess` -> `verifyAccess` in Web Serials;
  the edition sync book list, count and retry take `LibraryScopeService.visibleIdsOrAll` (the
  `WANTING_USERS_CTE` fan-out is on upstream's `library-scope-guard.test.ts` allow-list); the Watchlist
  summary cache uses `principalCacheKey`; `MonitoredGateway` authenticates through upstream's
  `AuthenticatorService.authenticateSocket` and refuses API-key sockets (fetch events carry the
  owner's full scope), so `MonitoredModule` no longer registers its own `JwtModule`. Fork routes are
  stricter than upstream's own credential routes: `@InteractiveOnly` on ABS settings PATCH/DELETE and
  `test-connection` (it would send the stored token to a caller-chosen host) and Web Serials settings
  PUT; `@KeyReadSafe` on the Web Serials `print-state` POST. `isbn13To10` in the Hardcover edition
  evidence moved to upstream's `isbn10FromIsbn13` (which also checks the ISBN-13 checksum).
  Migration 0142 recreated `download_clients_adapter_type_chk`; the Shelfmark row was parked (dev DB
  ledger 143 -> 147). The 156 fork routes (fork controllers plus fork routes in upstream's cover,
  scanner and book-request controllers) are in the authorization matrix gap baseline
  `uncovered-routes.json`, taken from the live labels, so upstream's "every route is inventoried or in
  the gap baseline" check passes. Run the suite with an empty `SETUP_BOOTSTRAP_TOKEN` (the dev `.env`
  token makes setup fail with 403). Known leftovers: the suite's "proves allow-path for each
  permission" test fails, as it has since the fork added `audiobookshelf_sync`, `edition_sync` and
  `web_serial_access`, because no inventoried route carries them. A post-merge review (five lenses,
  verified by a senior pass, fixed, re-reviewed) then tightened fork access to upstream's levels:
  the sidecar-first single-book cover re-extract, `re-extract-metadata` and alignment build/cancel
  now need editor access to the library. A staging client (TorBox) is no longer held back by the
  shared-torrent rule when an earlier request already imported the same item. `startScan` accepts
  upstream's boolean `forceFullScan` again, so upstream e2e specs run the full scan they ask for.
  Dead fork helpers went (`resetAudioConvertSettings`, `normalizeEditionSyncOverride`,
  `monitoredDateTime`, `NarrationTimeline.clipStart`, the audio-convert `mapWithConcurrency`, now
  upstream's), and the unused `clientsEmpty.note` string is upstream's again. Deferred: moving the
  Hardcover client additions, batch import, `useMediaOverlay`, release inspection, router/nav
  entries and book-request repository methods into fork-owned files; the edition sync overlay
  permission check by principal; content filters on Watchlist match writes; the 409 for a fully
  locked single-book cover re-extract. Read-only keys can call `GET /monitored/authors/:id` and
  `GET /monitored/releases`, which run an idempotent availability repair that writes match rows;
  `audio-convert.utils.test.ts` "keeps a run that prints nothing" is timing-flaky under the full suite.

- **2026-11-08, upstream v3.7.0 (`6f8f5f481`), 33 commits.** Upstream added book merge
  (`BookConsolidationService`, the `book_merges` redirect), the rTorrent client, Book Dock joins, its
  own `AppChart` and static cache headers. The fork's perf work moved onto upstream's where they did
  the same job: all charts use upstream's `AppChart` (`lib/echarts-register.ts` deleted),
  `applyStaticCacheHeaders` replaced `cacheControlFor` in `main.ts`, and the fork keeps only the
  hashed foliate folder check in `static-cache.utils.ts` and the `vendor` chunk group beside upstream's
  `lucide-icons` in `vite.config.ts`. Upstream's merge deletes the source book and its FK guard only
  walks `db/schema`, so fork rows would have cascaded or gone null (a null match makes the Watchlist
  re-grab an owned work). Added the `BookConsolidationParticipants` seam (see Landed seams) with a
  participant per owning module and `book-merge-fork-rules.test.ts`, which fails when a fork table
  gains a FK to `books` without a rule. Watchlist rejections follow the merge: a rejection of the kept
  book is dropped from a work the source book owned, and a source rejection stays behind when its work
  now matches the kept book, both matched by provider identity key or `work_id`, so neither unmatches an
  owned work at the next refresh. A title-keyed rejection matches only through `work_id`. `main.ts` is
  byte-identical to upstream again, so the fork's 1h cache on `provider-icons` is gone.
  `BookMissingFormatRequest.vue` skips the Watchlist lookup in the owned state, because upstream's new
  linked-edition spec requires no network calls there. Known leftovers:
  S's edition index file stays on disk and on K's file list until removal learns merged-book
  provenance; `book_request_batch_units.book_id` has no FK and can dangle;
  fork routes do not follow merged-book aliases; a merge during a Whisper build is not blocked; an
  automatic Watchlist match does not survive a refresh when the kept book's title does not match the
  work (a link does, and the merge review lets the owner keep the matching title). The stored shelfmark
  client row is parked
  and restored across upstream's `download_clients_adapter_type_chk` rewrite.

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

**Book merge participants.** `BookConsolidationService` calls
`BookConsolidationParticipants.moveAll(tx, kept, source)` on its own transaction right before it deletes
a book, in `consolidate` and on the no-user-data path of `absorbDuplicate`. The registry is a fork-only
file. In upstream files, the service gains an `@Optional()` constructor argument and those two calls,
and `book-consolidation.module.ts` provides and exports the registry. Each fork module registers a
`*-book-consolidation.participant.ts` in `onModuleInit` and owns its SQL. The collision rule is that the
kept book wins. A new fork FK to `books` needs an entry in `book-merge-fork-rules.test.ts`, which fails
until it has one. Cover placeholders need no participant: the fork's hunk in `adoptSlots`
(`book-cover-store.service.ts`) carries the placeholder flag with the slot after commit, and on the
book-move and scanner paths the slot and flag cascade together.

## Current conflict surface (semantic, `-w`)

### Book Knowledge as the story guide

Measured with `git diff -w --numstat upstream/main` on 2026-11-26 (36 added, 3 removed, 26 of the added in one test).

| Upstream file                                              | Added | Removed | Hook                                                                                                                                                                        |
| ---------------------------------------------------------- | ----: | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/modules/story-guides/story-guides.module.ts`   |     3 |       1 | Import the fork module and providers, add `BkPipelineModule` to `imports`, and list `...bkStoryGuidePipelineProviders` after upstream's own `STORY_GUIDE_PIPELINE` provider |
| `server/src/modules/story-guides/story-guides.service.ts`  |     1 |       1 | `statusFor` passes `own.enabled && (await this.feature.buildable?.()) !== false` to `buildReason`, so Build is not offered while Book Knowledge is off                      |
| `server/src/modules/ai-jobs/ai-feature.ts`                 |     4 |       0 | Optional `progress(phase, done, total)` on `AiStepContext`; optional `coverageOf(artifact)` on `AiFeature`                                                                  |
| `server/src/modules/ai-jobs/ai-job-runner.service.ts`      |     2 |       1 | `runUnit`'s context passes `progress` to the lease-guarded `AiJobRepository.setProgress`; `assemble` stores `Math.min(coverage, run.feature.coverageOf?.(artifact) ?? 1)`   |
| `server/src/modules/ai-jobs/ai-job-runner.service.test.ts` |    26 |       0 | A unit's own progress lands between the step's start and its final count; the stored coverage is the lower of the engine's and `coverageOf`'s                               |

The Book Knowledge file-selection hooks in `book.repository.ts` and `book-read.service.ts` are gone: the query is
`BookKnowledgeRepository.knowledgeFileCandidates`.

### Web Story Guide tab

Measured with `git diff -w --numstat upstream/main` on 2026-11-27. The feature column
isolates this tab's changes from earlier fork changes in the same files.

| Upstream file                                                   | Feature added / removed | Total added / removed | Hook                                                                  |
| --------------------------------------------------------------- | ----------------------: | --------------------: | --------------------------------------------------------------------- |
| `client/src/features/book/lib/book-detail-tabs.ts`              |                   1 / 1 |                 1 / 1 | Recognize the tab query value                                         |
| `client/src/features/book/components/detail/BookDetailTabs.vue` |                   5 / 1 |                 5 / 1 | Read the optional availability flag and insert the tab after Chapters |
| `client/src/views/BookDetailView.vue`                           |                   7 / 1 |                21 / 7 | Provide availability, lazy-load the tab and fall back to Details      |
| `packages/types/src/index.ts`                                   |                   1 / 0 |                13 / 0 | Re-export the fork recap contract                                     |
| `client/src/locales/en.json`                                    |                 167 / 0 |             2890 / 52 | Tab, window title, section, toolbar and unavailable-state copy        |

The cut-based ranking lives entirely in the tab overlay and adds no upstream hooks.

### Jobs queue action and request drawer hooks

Measured with `git diff -w upstream/main --numstat`. Totals include the existing fork changes in each file.

| Upstream file                                                      | Added | Removed | Hook                                                                                                            |
| ------------------------------------------------------------------ | ----: | ------: | --------------------------------------------------------------------------------------------------------------- |
| `server/src/app.module.ts`                                         |    16 |       0 | Registers fork modules, including `ForkJobReorderModule`                                                        |
| `packages/types/src/index.ts`                                      |    11 |       0 | Exports fork contracts, including `fork-job-reorder`                                                            |
| `packages/types/src/jobs.ts`                                       |    13 |       1 | Shared action kinds for adjacent movement and starting                                                          |
| `client/src/features/jobs/lib/job-presentation.ts`                 |     9 |       3 | Start uses an action button, adjacent moves stay on the grip, and front-of-queue actions stay in the row menu   |
| `client/src/features/jobs/lib/job-copy.ts`                         |     8 |       7 | Optional per-type action labels and result messages                                                             |
| `client/src/features/jobs/components/JobTableRow.vue`              |    45 |      13 | Reorder grip, Open/Review link with Jobs drawer routing for request URLs, menu-only actions and per-type labels |
| `client/src/features/jobs/views/JobsActivityView.vue`              |    21 |       7 | Drag bindings, per-type results for single-type targets, and the request drawer host in displayed row order     |
| `client/src/features/jobs/views/JobsActivityView.test.ts`          |    37 |       4 | Covers row-only movement, Start in the selection bar and keyboard access during progress refresh                |
| `client/src/router/index.ts`                                       |    18 |       0 | Fork routes, including the request detail child of Jobs Activity                                                |
| `client/src/components/AppLayout.vue`                              |     3 |       0 | Keeps the app view keyed to Jobs Activity while the request drawer is open                                      |
| `client/src/features/book-requests/composables/useRequestQueue.ts` |     1 |       1 | Lets the shared stepper accept Jobs rows adapted to request IDs                                                 |
| `client/src/locales/en.json`                                       |  2753 |     143 | Grip labels, movement results and per-type Move to top copy, alongside existing fork copy                       |

### Release picker: file panel width and Shelfmark search budget

| Upstream file                                                                     | Added | Removed | Hook                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ----: | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/features/book-requests/components/ReleaseFileInspectionPanel.vue`     |   141 |      47 | Includes `min-w-0` on the root box so the fork's one-line file names in `ReleaseFileTree.vue` scroll in place instead of widening the release card on phones |
| `server/src/modules/book-request/indexers/indexer-adapter.ts`                     |    26 |       0 | Optional `ReleaseQuery.interactive`, set when a person is waiting on the search                                                                              |
| `server/src/modules/book-request/indexers/indexer-config.service.ts`              |     4 |       1 | Reads the fork's standalone timeout and uses the standard indexer settings error for invalid values on save                                                  |
| `server/src/modules/book-request/indexers/indexer-config.service.test.ts`         |    67 |       0 | Covers timeout resolution, manager precedence, unset values and the save error code on create and update                                                     |
| `server/src/modules/book-request/indexers/indexer-search.service.ts`              |   217 |      45 | Adds the interactive flag to the existing cache key and adapter query, with a helper for the automatic cache fallback                                        |
| `server/src/modules/book-request/indexers/indexer-search.service.test.ts`         |   415 |       9 | Covers flag propagation, one-way cache reuse, refresh, expiry and the query used for candidate refresh                                                       |
| `server/src/modules/book-request/fulfillment/request-fulfillment.service.ts`      |   394 |      48 | `prepareReleaseSearch` marks its search interactive; automation calls `search` directly and leaves it unset                                                  |
| `server/src/modules/book-request/fulfillment/request-fulfillment.service.test.ts` |   482 |      21 | Checks the release picker passes the interactive flag                                                                                                        |

The fork owns `indexer-search-cache.ts`, `indexer-search-timeout.ts` and their tests
under `server/src/modules/book-request/indexers/`.

The fork's `shelfmark.adapter.ts` marks slow sources during automatic searches and cuts their
automatic search budget to 4 seconds. The Requests and Watchlist release pickers and Watchlist
grab warm-up use the full per-source budget, and their failures leave the slow mark alone.
Standalone Shelfmark indexers accept 5 to 180 whole seconds on save and default to 20 seconds.
Picker searches read only their own cache entries. An automatic search without a refresh can
reuse a fresh picker result for the same request, overrides, indexer mode and source IDs when
its own result is missing or expired. The fallback derives the picker key from the existing
cache key by changing its final `interactive` field. This avoids sending another search to private trackers.

### 2026-11-14 surface shrink after the v3.8.0 merge

Measured on the v3.8.0 merge tree (`70c6a7cb0`, upstream `c77966cc5`) with
`git diff -w --numstat --diff-filter=M upstream/main`, excluding locales, `*.md`, `*.json`, tests and
`server/test`: **271 modified upstream source files, 11,544 semantic lines before and 10,603 after
(-941).** With tests and locales included, the total fell from 25,939 to 24,169 lines (-1,770). The
2026-11-14 merge review's figure of 257 files and 9,995 lines used a different filter, so compare
against the numbers here.

| Upstream file                                                  | Before | After | Where the fork code went                                                                      |
| -------------------------------------------------------------- | ------ | ----- | --------------------------------------------------------------------------------------------- |
| `metadata-fetch/providers/hardcover/hardcover.client.ts`       | 231    | 51    | `monitored/providers/hardcover-catalog.client.ts` calls upstream `post` (now public)          |
| `metadata-fetch/providers/hardcover/hardcover.types.ts`        | 126    | 5     | `monitored/providers/hardcover-catalog.types.ts`                                              |
| `book-request/fulfillment/request-import.service.ts`           | 402    | 46    | `batch/request-batch-import.service.ts` behind `@Optional() REQUEST_IMPORT_HOOK`              |
| `book-request/fulfillment/book-request-download.repository.ts` | 81     | 7     | `book-request-download-fork.repository.ts` (base class)                                       |
| `book-request/indexers/indexer-operation-lock.ts`              | 47     | 4     | `indexer-shared-slots.ts` (base class, own `runShared` state)                                 |
| `book-request/book-request-self-fulfil.controller.ts`          | 57     | 2     | `book-request-self-fulfil-fork.controller.ts` (same prefix, guards and decorators)            |
| `book-request/book-request.module.ts`                          | 51     | 56    | registers the fork controller and the import hook                                             |
| client `router/index.ts`                                       | 79     | 16    | `router/fork-routes.ts`, spread in place                                                      |
| client `settings/lib/settings-nav.ts`                          | 49     | 12    | `settings/lib/fork-settings-nav.ts`, spread in place                                          |
| `book/audiobook-ebook-progress-sync.service.ts`                | 114    | 98    | `resolveAudioBookPosition` moved to `audiobookshelf/audiobookshelf-audio-position.service.ts` |
| `book/book.service.ts`                                         | 41     | 37    | `resolveAudiobookPositionForExternalSync` pass-through deleted                                |

What stays in upstream files, and why:

- `hardcover.client.ts` keeps the `surfaceFailures` / `timeoutMs` options inside `post` (they
  change how the request itself fails), `queueDelayMs`, the `book_series` line in `BOOK_FIELDS`, and
  exports of `BOOK_FIELDS` and `releasedBy` for the fork queries. `post` takes `op: string`.
- `request-import.service.ts` keeps one optional hook argument and two call lines (`contentPath`, then
  `importBatch`), `claimDestination` / `placeUnit` made public, the `MAX_UNIQUE_SUFFIX_ATTEMPTS`
  export, and the fork's single-download changes that were never batch code (`clientPath`, the
  `readdir` check, `unreadableDownloadMessage`). With the hook absent the import path is upstream's.
- `BookRequestDownloadRepository` and `IndexerOperationLock` now `extend` fork base classes. Their
  fork methods are called from upstream files (`download-monitor`, `download-removal`,
  `request-fulfillment`, `indexer-search`) that already depended on them, so injecting separate fork
  classes would keep the same dependency for about two more lines per caller. This is a deliberate
  exception to the `@Optional()` seam pattern, not a new coupling: removing the fork still means
  editing those callers, exactly as before.

Not attempted in this pass (ask the owner first): `useMediaOverlay.ts` as a fork copy (~430) and
the release inspection extras in `request-fulfillment.service.ts` (~150).

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

| File                                                                                                     | Semantic          | Owner         | Status                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `scanner/scanner.service.ts`                                                                             | 353 (2026-11-24)  | ABS           | Phase B (fork-internal shrink only; see rejected list)                                                  |
| `metadata/metadata.service.ts`                                                                           | 134               | ABS           | cover/sidecar precedence, no ABS identifiers                                                            |
| `metadata-fetch/providers/hardcover/hardcover.client.ts` + `.types.ts`                                   | 168 / 114         | monitored     | author search, contributions, per-format editions; reuse `BOOK_FIELDS`                                  |
| `user-book-status/reading-attempt.service.ts` / `.repository.ts`                                         | 61 / 37           | ABS           | irreducible core (origin-based dedupe, soft-delete aware)                                               |
| `book-request/book-request.repository.ts` / `.service.ts` / dto                                          | 47 / 18 / 8       | monitored     | `auto_grab` column, research filter, create passthrough                                                 |
| `reader/epub/epub.service.ts`                                                                            | 128               | alignment     | `extractSpineText` seam + Range/ETag/HEAD streaming via fork-only `EpubMediaStreamService`              |
| client `settings/LibrariesSettings.vue` / `LibraryRowActions.vue`                                        | 39 / 10           | ABS           | re-extract metadata library action                                                                      |
| `authors/authors.repository.ts`                                                                          | 38                | monitored     | name lookup/create + portrait candidates (was 73)                                                       |
| client `reader/ReaderView.vue` / `epub/composables/useFoliate.ts`                                        | 29 / 15           | alignment     | resume ladder via the `crossFormatResume` open option (was 38 / 37)                                     |
| `dashboard/dashboard-widget.service.ts`                                                                  | 17                | ABS           | status-change listener (generic, propose upstream)                                                      |
| client `author/views/AuthorsView.vue` / `AuthorTile.vue` / `AuthorIndexRow.vue`                          | 35 / 25 / 25      | monitored     | monitor action via `useMonitorAuthorAction()`                                                           |
| `.github/workflows/container-image.yml`                                                                  | 32                | fork          | deliberate: any-branch manual builds + stable branch-name image tag                                     |
| client `router/index.ts` / `useSidebarNav.ts` / `settings-nav.ts` / `AppSidebar.vue`                     | 28 / 21 / 19 / 12 | mixed         | route, nav and badge registration (ABS + monitored)                                                     |
| `achievement/achievement.repository.ts`                                                                  | 4                 | ABS           | `'audiobookshelf'` in upstream's two source `IN` lists (was 22)                                         |
| `common/utils/ssrf.utils.ts`                                                                             | 0 (was 21)        | ABS           | byte-identical to upstream since 2026-11-19; fork callers use upstream's `isLinkLocalOrMetadataAddress` |
| client `book-requests/components/RequestSearchPanel.vue`                                                 | 20                | monitored     | quick-monitor bell via `useMonitorGroupAction()` (was 75)                                               |
| `.env.example` / `Dockerfile` / `config/config.ts`                                                       | 17 / 15 / 6       | alignment     | whisper stage + alignment config, additive                                                              |
| `audiobook/audiobook.service.ts` / `.module.ts`                                                          | 12 / 0            | ABS+alignment | `book:progress-changed` emit from `putPlaybackState` - **propose upstream**                             |
| `book-request/fulfillment/request-automation.service.ts` / `indexers/indexer-search.service.ts` / module | 13 / 11 / 4       | monitored     | `grabAllowed`, `IndexerSearchRequest` Pick, exports                                                     |
| client `book/.../tabs/DetailsTab.vue`                                                                    | 191 (30+/161-)    | alignment     | `LinkBookControl` + `useBookProgressRefresh`; upstream read-aloud sync popover removed                  |
| `metadata/metadata-extraction.service.ts`                                                                | 12                | ABS           | the extractor seam itself                                                                               |
| client `useLibraryCreator.ts`                                                                            | 12                | ABS           | UI registration                                                                                         |
| `book/book.service.ts` / `book.controller.ts`                                                            | 10 / 8            | ABS           | progress emit for file progress; `BULK_COVER_REFRESHER` seam (was 19)                                   |
| `authors/authors.module.ts` / `author-enrichment-executor.service.ts`                                    | 9 / 8             | monitored     | export + `allowOrphan` flag                                                                             |
| `app.module.ts`                                                                                          | 20                | all           | fork module registrations, including `ForkStoryGuideModule` (2 lines)                                   |
| `position-converter/position-converter.module.ts`                                                        | 1 (1+/1-)         | story guides  | exports `EpubDomService` for the recap route                                                            |
| `notification/notification.service.ts`                                                                   | 34                | web serials   | `groupKey` passthrough and `upsertByGroupKey` (rewrite a group's newest row in place)                   |
| `notification/notification.repository.ts`                                                                | 20                | web serials   | `updateLatestByGroupKey`, type taken from `excluded` on the group upsert                                |
| client `notifications/components/NotificationItem.vue`                                                   | 139               | monitored     | release-available icon and the request action on Watchlist release notifications                        |
| `packages/types/src/notification.ts`                                                                     | 10                | mixed         | four enum members, two categories and their meta entries (monitored, web serials)                       |
| `scripts/migrate.ts`                                                                                     | 2                 | ABS           | pre-migrate row parking call (generic name, no ABS identifiers)                                         |
| `scanner/scanner.controller.ts` / `scanner.repository.ts`                                                | 7 / 2             | ABS           | re-extract endpoint                                                                                     |
| `achievement-events.service.ts` / `koreader.service.ts`                                                  | 6 / 3             | ABS+alignment | `occurredAt` widening - **propose upstream**                                                            |
| `metadata-fetch.module.ts` / `providers/goodreads/goodreads.provider.ts`                                 | 2 / 2             | monitored     | `GoodreadsProvider` exported, `fetchHtml` made public (was a copy)                                      |
| `scanner/lib/classify.ts`                                                                                | 1                 | ABS           | `metadata.json` sidecar recognition (was 6)                                                             |
| Book Knowledge: 17 files, `ReaderView.vue` 27 the largest (2026-11-24, uncommitted)                      | 91 total          | knowledge     | see the per-file table in its overlay section                                                           |
| Book Knowledge entry and description rules                                                               | 0 added           | knowledge     | fiction role review skips names, context filtering, shared-line retries and description refresh         |
| Book Knowledge fiction line prompts                                                                      | 0 added           | knowledge     | lasting details by kind and stat or skill labels visible at the unit cutoff                             |
| Book Knowledge About and Now prose                                                                       | 0 added           | knowledge     | core identity facts, situational Now lines, and fiction prose checks in fork-owned files                |
| everything else                                                                                          | <= 6 each         | mixed         | enum members, `Record<Union>` exhaustiveness, trivial registrations                                     |
| `client/src/locales/*.json`                                                                              | ~60 each          | all           | i18n keys, trivial conflicts                                                                            |

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

| Shared file                                             | Hook                                                                                                                                                                                                    | Conflict cost                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                                         | register `ReadingAlignmentModule` (20 lines across all fork registrations, including `ForkStoryGuideModule`)                                                                                            | 2 lines, trivial                                                                                                                                                                                                |
| `reader/epub/epub.service.ts`                           | `extractSpineText()` added (spine text for matching/backfill); Range/ETag/HEAD streaming of EPUB media through `EpubMediaStreamService` (`epub-media-stream.service.ts`, `epub-zip-range.ts`)           | real; generic methods - keep them generic                                                                                                                                                                       |
| `config/config.ts`                                      | `whisperPath`/`whisperModel`/`ffmpegPath`/`readingAlignment*` on `appConfig`                                                                                                                            | additive                                                                                                                                                                                                        |
| `achievement-events.service.ts` + `koreader.service.ts` | `occurredAt` (effective activity time) on the progress event                                                                                                                                            | **generic, shared with ABS**, additive/removable - propose upstream                                                                                                                                             |
| `packages/types/src/index.ts`                           | `export * from "./reading-alignment"`                                                                                                                                                                   | 1 line, trivial                                                                                                                                                                                                 |
| client `DetailsTab.vue`                                 | `<LinkBookControl>` in the action bar, replacing upstream's read-aloud sync popover (the invite chip stays upstream's); passes `editionProgress`, forwards `saved`                                      | keep additive (do not relocate upstream buttons)                                                                                                                                                                |
| client `read-aloud/components/ReadAloudJobCard.vue`     | optional `initialDetailsOpen` prop seeding `detailsOpen`, so the panel's Review lands with Details expanded                                                                                             | 2 lines, trivial                                                                                                                                                                                                |
| client `book/.../tabs/FilesTab.vue`                     | consumes `?readAloud=details` once (like upstream's `readAloud=create`), passes `initial-details-open` to the job card and scrolls it into view                                                         | ~12 lines, additive                                                                                                                                                                                             |
| client `ReaderView.vue`                                 | open-time `fetchEbookCrossFormatResume(bookId, fileId)`, passed to `useFoliate` as the `crossFormatResume` open option; the server answers only for the aligned plain EPUB of a book with no read-along | one option field, one branch, a `{ crossFormatResumed }` return                                                                                                                                                 |
| `audiobook-chapters/audiobook-chapters.module.ts`       | register and export `AudioPlayOrderService`                                                                                                                                                             | 2 lines, trivial                                                                                                                                                                                                |
| `book/audiobook-ebook-progress-sync.service.ts`         | `resolveAudioBookPosition` + the `AudioPlayOrderService` injection, feeds the ABS push; `itemDurations` gives a track-boundary clip of unknown length the rest of its section's declared length         | ~30 lines; since 2026-11-19 the guard is `clockItems`, an adapter over upstream's `locateItemByNarratedSeconds` and timeline helpers; drop it once upstream stops treating an unknown-length clip as open-ended |
| client `ReadingLogLedger.vue` / `ReadingLogTab.vue`     | one `audiobookshelf` pill token (ABS); `useBookProgressRefresh` (6 lines)                                                                                                                               | trivial                                                                                                                                                                                                         |
| `Dockerfile`                                            | `whisper-builder` stage compiles whisper.cpp `v1.9.1` (CPU-only, static) -> `whisper-cli`; runtime adds `libstdc++`/`libgomp`                                                                           | isolated stage + one COPY                                                                                                                                                                                       |
| `Dockerfile` + `workers/read-aloud/Dockerfile`          | `npm install -g pnpm@11.28.9` to match `packageManager`; upstream's `11.22.0` tries to switch itself and fails the arm64 build on the unlocked `@pnpm/exe.linux-arm64`                                  | 1 line each; take upstream's pin once it matches `packageManager`                                                                                                                                               |

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

**Covers:** a work's `coverUrl` comes from Hardcover only (`cluster-merger.ts`). Audible's art is
kept apart as `audioCoverUrl` (`author_catalog_works.audio_cover_url`, added by the bootstrap) so a
client can show the audiobook cover of a release it does not own yet; existing works fill it on
their next catalog refresh.

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

**Release picker.** The Watchlist search routes and the grab route's warm-up mark their indexer
searches interactive so that Shelfmark uses the full per-source budget.

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

## Story guide content route for Absorb

`GET /api/v1/story-guide-content/files/:fileId` serves story guide content to Absorb with a login
token. Absorb cannot attest, so this route skips App Attest and still refuses API keys. It calls
`StoryGuidesService.content` for book access checks, format selection and reader fixes.

The route sends the body and ETag returned by `StoryGuidesService.content` as is, including any
chronicle stored in the guide. It passes `If-None-Match` through and sends a bodyless 304 when the
service reports a match.

`GET /api/v1/story-guide-content/files/:fileId/recap?stop=0|1` uses the current user's saved EPUB
progress to return visible summaries and, by default, a reading-help recap. It reads chapter text
through the exported `EpubDomService` and sends one passage ending at the saved position to
`ReadingHelpService.answer`. Reading-help availability and provider failures are reported in
`stop` so the visible summaries can still be served. Absorb sends `stop=0` to skip the answer
when it already has one for the saved position. The recap route is throttled to 60 requests a
minute, like upstream's mobile reading-help route. A current-chapter summary is shown only when every
copy of its quote lies before the saved position, and the position's chapter title is the nearest
titled section at or before it.

**Owned (fork-only) files:** `server/src/modules/fork-story-guide/`.

**Plugin removal:** unregister `ForkStoryGuideModule` in `app.module.ts` (one import and one entry).

## Web Story Guide tab overlay

The book detail page offers Story Guide after Chapters whenever the server offers story guides
(`story-guides` supported and served or building), whatever the book's files; with the feature off the
tab stays hidden and a `?tab=story-guide` link falls back to Details. A book without an EPUB, KEPUB,
MOBI, AZW3 or AZW content file gets `StoryGuideTabUnavailable.vue` instead of the guide: the not-built
panel's look without buttons, and no status, guide or recap request. `storyGuideUnavailable` picks the
first reason that applies: audio only, any comic archive, other formats (named in the text), or no
content files. `StoryGuideTab.vue` chooses between that panel and `StoryGuideTabContent.vue`. Reading a guide needs no permission; building, Update and the
actions menu stay behind `library_generate_story_guide`. The tab uses the card's status API for
source-file selection, build status and Update (people without the build permission get a single
status read instead of the card's polling). The tab no longer renders upstream's `StoryGuideCard`:
`StoryGuideTabState.vue` draws not built, building, queued, paused and failed jobs itself (a centered
panel without a guide, a slim bar above it with one) from the same `useStoryGuideStatus` presentation,
`perform` and `StoryGuideConfirmDialog` confirmations, and the tab's menu keeps the guide's own
actions while job controls sit on the bar. The Timeline merges chronicle notes that repeat one
event per entity (same quote anchor, or the same text after whitespace collapse, within a chapter)
into one item carrying every entity's chip. It loads format 1 from the existing
fork content route and asks the recap route for a quote cut with `stop=0` before requesting a
Reading help recap with `stop=1`. Revalidation on book progress events keeps the rendered cut
until the new one arrives, including when a re-read moves the position backward; a backward move
drops the recap's stop label, and an older recap says where it was written. The stop text is kept only
on a strictly later percentage or the same CFI at the same percentage. An event that arrives while the
cut or a recap loads is held and applied once they settle, and a newer event aborts an older read. While a job runs the tab
lists five steps (Reading the book, Finding names, Checking who's who, Writing descriptions, Finishing up)
from the job's phase, with minutes left once Writing descriptions can estimate it. Previously (with an "All
chapters" button) and the Timeline page their chapters 10, 20 or 50 at a time, or all of them, newest
or oldest first. Both lists share one order and page size per browser, newest first and 10 by default,
so a choice holds across sections; only the reader's own choice of All renders more than 50 chapters. The pager names the first and last chapter on the page. Ties show the chronicle's pair note for the two names,
else the quote, both inside the cut. The constellation draws at most 120 links, strongest first.

A bar under the position card holds the tab's tools, like the library and Watchlist bars: one search
box, the People / Places / Terms kinds with counts, the shared order and page size (shown only where a
list pages chapters: Story so far, Timeline and search results), and the guide's actions menu, which
moved off the position card. From two letters, outside Characters, the search replaces the section with
results at the cut: matching names first (six shown, the rest one click away in Characters), then
Timeline notes that say the words or tag a matching name, paged like the Timeline, then chapter
summaries that say them, all highlighted. The section list counts matches while a search is on. On
Characters the box filters the cards in place and the kinds act as one switch, as the old in-section
pills did; elsewhere the kinds toggle independently and hide the chips of a kind that is off.

The section list calls the names section Concepts when the guide's `mode` is nonfiction, and Characters
otherwise, including guides built before the mode was recorded.

Characters, places and terms use the visible chronicle to rank at the reader's cut. Two or more
visible rows covering at least a quarter of the distinct visible chapter rows rank Main. Zero or one
row ranks Mentioned when the cut has any rows, and other entries rank Supporting. With no visible rows,
all entries rank Supporting. Within a rank, row count and then visible tie count determine priority.
The constellation uses this ranking for its 80 stars and their sizes.

A character's sheet says "Last seen in Chapter N" in place of Now once the reader is 10 or more
chapters past the character's latest visible chronicle row, own or merged join, matching Absorb. The
reader's chapter comes from the chronicle unit holding the cut, else the section title at the cut; with
no chapter number on either side the sheet keeps Now.
An entry's sheet leads with a card ("Who they are" for characters and groups, "What it is" for the
rest) holding the newest visible description, with the earlier ones folded under it in reading order.
Below it, Timeline and Ties are tabs (Ties also holds "Often with"). The Timeline is a node list of
the entry's chronicle notes from the first one to the reader's chapter. Collapsed, it fills the sheet
from where it starts to the bottom of the screen (at least 240px), renders at most 40 notes, and ends
in one "Display all" node that shows every note; there is no second expand or collapse. A list
within 96px of fitting shows whole. Each chapter's title sits in bold above its notes. A search over
notes and chapter titles and an order flip cover every note. Rows are built in reading order for both
orders, so keyboard and screen-reader order match the screen.

The recap uses the current user's EPUB CFI on the guide's own source file (progress on another file of
the book does not move the cut) and returns the spine index and original quotes whose
last whitespace-collapsed match ends before or at the saved offset. The tab applies this to
names, profiles, joins, summaries, chronicle notes, ties and co-mentions. Chapter titles remain
visible at every position. Spine sections are grouped into chapters: a titled section starts a
chapter, untitled sections join the one before, and untitled sections before the first title form
an "Opening" group. Every label uses the chapter title, never a spine number; recap `previously`
rows carry their spine index `s` so the tab can group them. Upstream format 1 guides work with
their available fields.

**Owned (fork-only) files:** `client/src/features/story-guide-tab/` and
`packages/types/src/fork-story-recap.ts`. The cut extends the existing
`server/src/modules/fork-story-guide/` recap route. The hooks above register the web surface.
Disabling the page's availability provider falls back to Details, preserving the original card.

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

## Edition sync overlay (read-aloud timing index)

The fork runs upstream's read-aloud worker as a scheduled background job and keeps only an audioless
**timing index** per book (`<stem>.bookorbit-timings`, a zip next to the book that the scanner files
under Extras). Ebook / audiobook / Kobo / KOReader / ABS position sync maps through it at sentence
level via upstream's own `AudiobookEbookProgressSyncService`, and Create read-aloud reuses it to
rebuild a full EPUB3 in seconds instead of re-analysing. Gated by the fork permission `edition_sync`
(user side) and `manage_app_settings` (schedule, run now, clear unused). Whisper (`reading-alignment`)
stays only as the fallback for books whose worker run failed.

The optional rebuild protocol field `sourceEntries` lists `{ href, size, crc32, position }` for images
and fonts omitted from the index when their source EPUB path, size and CRC32 match. `position` is the
number of index entries (timing files excluded) that preceded the asset, so rebuild restores each one
from the source EPUB at its original place and the output matches a full run entry for entry. A
mismatch falls back to full alignment; an entry without `position` goes last. Provenance
remains version 1; older indexes without this field rebuild as before.

**Read along via index.** A book with a plain EPUB, an audiobook and a ready index, but no
read-along EPUB, reads along anyway: the reader's Listen plays the audiobook with each sentence
highlighted, as Absorb does. `EpubIndexNarrationService` builds a media overlay playlist from the
index (clips mapped through provenance onto the book's own audio files, ordered by provenance
order, sentences that run backwards dropped) and serves the audio under the virtual path
`bookorbit-audio/<fileId><ext>` through the normal EPUB file routes. Each sentence also gets its
place in the plain chapter, counted in non-whitespace characters of text and CDATA in `<body>`
outside script, style, svg and math, with a length and hash check; the client wraps it in
`data-bo-ra` spans only when both match, and foliate's CFIs look through those spans, so
positions, highlights and notes stay the plain EPUB's. The book page's Editions card shows the
dashed Read-aloud row with "Available via index". The index is read from a private temp copy,
since unzipper reopens the file per entry and an index replaced or cleared mid-read would
otherwise throw from an unhandled stream; book info reads only its provenance, through one open
handle, cached by path, mtime and size. Builds are cached (LRU, 8) by index, EPUB and audio paths,
and audio bytes are authorised from provenance without a build. The Editions row shows only while the plain EPUB the index was aligned to (`index.epubFileId`) is still one of the book's files. A saved
narration sentence is resumed only when this session's index narration placed it; otherwise the
saved CFI wins. If the playlist misses the reader's 10 s wait, Listen waits for it, reopens the
book in place and narrates; TTS only if it never comes. Narration progress for a plain EPUB is
placed through the index (`sourceBookFileId`), so background narration moves the text and
audiobook positions forward.

**Owned (fork-only) files - never conflict:** `server/src/modules/edition-sync/` (module, bootstrap
SQL, repository, services, controller, DTOs, including `edition-sync-fallback.service.ts`),
`workers/read-aloud/src/rebuild.ts`, `workers/read-aloud/src/rebuild-metadata.ts`,
`workers/read-aloud/src/rebuild-error.ts`,
`workers/read-aloud/src/audio-fingerprint.ts`, `workers/read-aloud/test/rebuild.test.mjs`,
`workers/read-aloud/test/fixtures/chapter-fingerprints.json`, `packages/types/src/edition-sync.ts`,
`client/src/features/edition-sync/` (including `composables/useTimingIndexReadAlong.ts`),
`server/src/modules/reader/epub/epub-index-narration.ts`, `epub-index-narration.service.ts` (+ tests),
`client/src/features/reader/media-overlay/lib/index-narration.ts` (+ test). Fork-owned files of
other features edited for this one (no upstream conflict): `client/src/features/reader/epub/foliate-loader.ts`
(+ test), `media-overlay/lib/media-overlay-playlist.ts` (+ test; `forgetMediaOverlayPlaylist`, failures
not cached), `media-overlay/lib/media-overlay-follow.ts`, `media-overlay/lib/headless-narration.ts`
(+ test; waits without the cap), `media-overlay/components/MediaOverlayStartButton.vue`,
`client/src/features/book/components/detail/details/EditionsReadAloudRow.vue` (+ spec). And three seam token files that live inside upstream folders:
`server/src/modules/read-aloud/read-aloud-hooks.ts`, `server/src/modules/book/overlay-source-provider.ts`,
`server/src/modules/position-converter/epub-dom-source-provider.ts` (each with a fork `*.test.ts`
beside it). Schema: `edition_sync_user_settings`, `edition_sync_book_overrides`,
`edition_sync_book_index`, `edition_sync_settings`, `edition_sync_runs`, created by
`EditionSyncSchemaBootstrapService` (idempotent SQL, `onModuleInit`), never Drizzle migrations.

**Seams / hooks in upstream files:**

| Upstream file                                                                           | Hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Conflict cost                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `book_files` (database trigger)                                                         | Bootstrap-owned `edition_sync_book_files_changed` trigger depends on `book_id`, `role` (value `'content'`), `size_bytes`, `mtime`, `file_hash`, `absolute_path`.                                                                                                                                                                                                                                                                                                                                                                                                       | No upstream source edit; verify columns on merge |
| `read-aloud/read-aloud.module.ts`                                                       | `exports: [ReadAloudWorkerClientService, ReadAloudWorkspace, ReadAloudWorkerService]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1 line                                           |
| `read-aloud/read-aloud-worker.service.ts`                                               | `@Optional() @Inject(READ_ALOUD_HOOKS) hooks = NO_READ_ALOUD_HOOKS` ctor arg; `adoptRunning` returns null when `hooks.ownsWorkerJob(jobId)`; `process()` passes the request through `hooks.prepareRequest`; `finish()` takes that request and calls `hooks.onOutputValidated` inside `publisher.withHeartbeat` after the `output_validated` activity                                                                                                                                                                                                                   | ~10 lines                                        |
| `read-aloud/read-aloud-lifecycle.service.ts`                                            | optional `READ_ALOUD_HOOKS` ctor arg; `removeOrphanFolders` adds `hooks.keepWorkFolders()` to the keep set                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 3 lines                                          |
| `book/audiobook-ebook-progress-sync.service.ts`                                         | optional `OVERLAY_SOURCE_RESOLVER` ctor arg; `selectOverlaySourceFile` is async, takes `(userId, bookId, ...)` and falls back to `overlaySource.resolveOverlaySource` when the book has no read-along EPUB; `resolveProgress` / `resolveEbookOverlayPosition` param types gain `userId`; `resolveProgress` keeps only EPUB targets (a resolved non-EPUB source is never written as progress); `timingIndexSourceFileId` + `isTimingIndex`, and `resolveOverlaySecondsFromEbookPosition` takes `timingIndexNarration` so a plain EPUB's index sentence places the audio | ~35 lines                                        |
| `position-converter/epub-dom.service.ts`                                                | optional `EPUB_DOM_SOURCE_RESOLVER` ctor arg; `getSpineEntry` asks `sources.resolveEpubDomSource` for a row that is not `epub`/`kepub` (`const [file]` became `const [row]` + one line)                                                                                                                                                                                                                                                                                                                                                                                | ~6 lines                                         |
| `app.module.ts`                                                                         | import + register `EditionSyncModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2 lines, additive                                |
| `packages/types/src/permissions.ts`                                                     | `EditionSync = "edition_sync"` + label "Edition sync" (no `PERMISSION_REQUIRES` entry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2 lines, additive                                |
| `packages/types/src/index.ts`                                                           | `export * from "./edition-sync"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1 line, additive                                 |
| `client/src/features/admin/lib/permission-presets.ts`                                   | `Permission.EditionSync` in the `readingIntegrations` group (not in `STANDARD_PRESET`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1 line                                           |
| `workers/read-aloud/src/protocol.ts`                                                    | `ReadAloudWorkerRebuildRequest` accepted on submit; validation of the `rebuild` block (`validation.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ~15 lines                                        |
| `workers/read-aloud/src/jobs.ts`                                                        | job records carry the optional `rebuild` block and pass it to the runner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ~6 lines                                         |
| `workers/read-aloud/src/runner.ts`                                                      | when `job.rebuild` is set: plan `preparing_audio -> aligning -> validating`, `rebuildFromIndex` in place of alignment, `RebuildMismatchError` falls back to the full pipeline in the same job                                                                                                                                                                                                                                                                                                                                                                          | ~45 lines                                        |
| `workers/read-aloud/src/server.ts`                                                      | authenticated `/health` adds `rebuild: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1 line                                           |
| `workers/read-aloud/test/fixtures/fake-pipeline.mjs`, `test/server.test.mjs`            | fixture support for the rebuild stage; health assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | test only                                        |
| `client/src/features/book/components/detail/details/BookEditionsCard.vue`               | prop `syncCount`, slots `header-action` and `status`, footer summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ~20 lines                                        |
| `client/src/features/book/components/detail/tabs/DetailsTab.vue`                        | mounts `useEditionSyncBookState` and the two edition-sync components inside the card; `useTimingIndexReadAlong` feeds the Read-aloud row's `via-index`                                                                                                                                                                                                                                                                                                                                                                                                                 | ~27 lines                                        |
| `reader/epub/epub.service.ts`                                                           | optional `EpubIndexNarrationService` ctor arg; `getBookInfo` sets `timingIndexNarration`; `getMediaOverlayPlaylist` takes `{ narrationFallback }` (reader route only, so Watch keeps the EPUB's own overlay); `streamMediaOverlayFile` and `streamFile` hand `bookorbit-audio/...` paths outside the archive to the service                                                                                                                                                                                                                                            | ~38 lines                                        |
| `reader/epub/epub.controller.ts`, `reader/epub/epub.module.ts`                          | media-overlay route passes `{ narrationFallback: true }`; `EpubIndexNarrationService` provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2 lines                                          |
| `book/book-read.service.ts`                                                             | `findAudioEbookProgressSyncFiles` pass-through                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 5 lines                                          |
| `book/book.service.ts`                                                                  | `resolveTextPosition` / `narratedSentenceCfi` take a plain EPUB's `{ userId, bookId }` and pass the index as `sourceBookFileId` to `fragmentToPositions`                                                                                                                                                                                                                                                                                                                                                                                                               | ~12 lines                                        |
| Upstream tests (test only)                                                              | `foliate-navigation.spec.ts`, `useFoliate.spec.ts`, `ReaderHeader.spec.ts`, `media-overlay-range.test.ts`, `epub.controller.test.ts`, `epub.module.test.ts`, `book.service.test.ts`, `audiobook-ebook-progress-sync.service.test.ts`: cases for the hooks above                                                                                                                                                                                                                                                                                                        | test only                                        |
| `packages/types/src/epub.ts`                                                            | `EpubBookInfo.timingIndexNarration?`, `EpubMediaOverlayTextPositions`, playlist `source?` and `textPositions?`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | additive                                         |
| `client/public/assets/foliate/epubcfi.js`                                               | `getChildNodes` / `nodeToParts` look through `data-bo-ra` spans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~25 lines                                        |
| `client/public/assets/foliate/view.js`                                                  | highlight/unhighlight light every `data-bo-ra` piece; a sentence with no element in its loaded chapter is neither followed nor marked                                                                                                                                                                                                                                                                                                                                                                                                                                  | ~12 lines                                        |
| `client/src/features/reader/epub/composables/useFoliate.ts`                             | load handler calls `markIndexSection`; `narrationViaIndex` / `indexNarrationMissing` refs; fragment resume only via `goToIndexSentence` for index books; `keepIndexNarration` open option                                                                                                                                                                                                                                                                                                                                                                              | ~20 lines                                        |
| `client/src/features/reader/ReaderView.vue`, `media-overlay/lib/media-overlay-range.ts` | resume highlight, start-from-page and in-view checks use every piece (`narratedPieces`); `ensureTtsAvailable` waits for a late index playlist (`listenOnceIndexNarrationLoads`)                                                                                                                                                                                                                                                                                                                                                                                        | ~15 lines                                        |
| `client/src/features/reader/epub/components/ReaderHeader.vue`                           | `viaIndex` label for Listen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | ~10 lines                                        |
| `client/src/features/settings/lib/settings-nav.ts`, `client/src/router/index.ts`        | `fork-settings` nav item and `settings-fork` route (ForkSettings.vue is fork-owned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2 x ~5 lines                                     |
| `client/src/locales/en.json`                                                            | `editionSync.*`, `book.detail.editionLink.readAloud.viaIndex*` and `reader.header.listenViaTimingIndex*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                          | additive                                         |
| `client/src/features/book/lib/sync-chain.ts`, `composables/useSyncChainPanel.ts`        | Whisper connector and build controls removed from the Position sync panel (fork-owned files; listed because the alignment scaffolding they still import is dead)                                                                                                                                                                                                                                                                                                                                                                                                       | n/a                                              |
| `docker-compose.yml`, `docs/READ_ALOUD.md`                                              | worker image default `ghcr.io/ahmed-mohamed01/bookorbit-read-aloud-worker:latest`; fork timing-index section                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1 line + section                                 |
| `.github/workflows/container-image.yml`, `.github/workflows/fork-release.yml`           | worker image scope/build/manifest/retag jobs; release waits for and retags the worker image                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | fork-only workflows                              |

`EditionSyncModule` is `@Global()` and supplies all three tokens (`READ_ALOUD_HOOKS`,
`OVERLAY_SOURCE_RESOLVER`, `EPUB_DOM_SOURCE_RESOLVER`), the same pattern as
`AudiobookshelfMetadataModule`. Every upstream injection is `@Optional()` with a no-op default, so
with the module unregistered upstream behaves byte-for-byte as before (pinned by the seam tests).

**Jobs queue:** Edition sync lists the running build, visible claimable pins, then individual backlog
books in run order. The keyset limit applies across both waiting lanes. Backlog counts are cached per
scope for 15 seconds, share in-flight reads, and are invalidated after successful queued actions.
Administrators without edition sync access see the running build and visible backlog, with ranks
that include the claimable pins. Edition sync users can move a book ranked below first to the
front of the pinned lane, swap adjacent claimable pins or promote a backlog book to the back of the
pinned lane. Cancel checks for other wanting users before writing an opt-out, and refuses without
changing preferences when someone else wants the book. While the scheduler is idle, a server
settings administrator can start a manual run from the first row in scope. The scheduler rechecks
the global queue head when starting and retries after a bounded batch of lost claim races. When
the server switch is off, pinned rows show Paused and link to `/settings/fork`, and backlog rows are hidden.

**Jobs queue drag and drop:** The fork client files `JobReorderHandle.vue`, `JobDragPreview.vue`, `JobDropIndicator.vue`,
`useJobRowDrag.ts`, `job-reorder.ts` and `job-reorder.api.ts` own the grip, keyboard dispatch and
pointer interactions. Drag targets come from the current page, across queue bands. The edition sync
backlog head and a lone pin at rank one accept a drop before them even without adjacent move actions.
Only rows with a move action get a grip. Its arrow keys take the adjacent actions and restore focus
when the moved job changes bands. The existing Jobs list composable refreshes the page after a drop.
Background refreshes leave drag and keyboard input enabled and preserve the table's `aria-busy` state.
After the drag threshold, the cover, title and queue detail follow the pointer on animation frames.
The original row stays dimmed in place and the drop line stays visible above the preview.
Edition sync and Convert to M4B use Move to top at ranks below first. Both front-of-queue actions
appear in More actions across all job types and remain available in the selection bar.

`ForkJobReorderModule` is registered in `app.module.ts` and imports `JobsModule` for the exported
source registry. Its session-only `POST /api/v1/fork/jobs/reorder` uses the Jobs view permissions.
The fork-owned `ReorderableJobSource` interface adds relative placement to the three fork adapters.
Audio conversions and web serials rotate the existing order keys over the affected range in the
viewer's lane under the queue lock. Edition sync places a book between the neighbouring pins,
spreads timestamps when the gap is too small, and treats the slot before the first visible backlog
book as the end of the pinned lane. The page identifies the backlog head so other backlog slots
stay unavailable. Only edition sync can express a drop after a row as before its next eligible row.
Audio conversions and web serials send the row under the pointer with `place: 'after'` for after drops.
A successful pin refreshes the count and wakes the scheduler. All three drops use
the existing Jobs change notifications. Removing the route takes one import and one registration
out of `app.module.ts`; removing the grip takes the client hooks in the conflict table above.

**Other fork queues:** Web serial owners swap adjacent jobs within their own jobs, and managers swap
in the global queue. Web serial bootstrap preserves the existing `queue_order, id` order with
distinct keys and uses sequences for new, resumed and prioritized jobs. Convert to M4B uses an
idempotent `queue_order bigint` bootstrap with a `created_at, id` backfill, front and back sequences,
and a partial claim index. Library managers can swap within editable libraries or move a job
ranked below first to the front. Claims and reorders use the same order and coordinate through transaction-level
advisory locks. The adapters publish state changes through the existing Jobs notifications.

**Plugin removal:** drop `EditionSyncModule` from `app.module.ts`, delete the owned files above, revert
the server and client seams in the table (the read-along-via-index rows go with it: without
`EpubIndexNarrationService` the EPUB hooks are no-ops). `reading-alignment/reading-alignment-pair.service.ts`
imports `../edition-sync/edition-sync-fallback.service` (optional injection) and
`edition-sync.module.ts` imports `ReadingAlignmentModule` for the fallback probe
(`ReadingAlignmentStatusService.hasReadyAlignment`); remove both imports with the module, or the
server does not compile. Whisper removal later: delete `reading-alignment/` and the two seams above;
`whisperFallback` on the book state becomes `false`. The worker image seams stay with the fork image
even if the server module is removed. The fork tables can stay in the database; nothing else reads them.

## Jobs request drawer overlay

Review and Open on Jobs rows with a request URL open `/jobs/activity/requests/:id` with the active
Jobs query. The fork route in `client/src/router/fork-routes.ts` renders the existing request panel
inside `JobRequestDrawer.vue`, which reuses the Requests drawer and stepper. The stepper follows the
distinct request-download entries on the current page in display order. Closing preserves the
Jobs filters, page and scroll. The same URL loads the drawer over Jobs directly, and the release
picker opens on the Requests page. Jobs retains its route permission and the panel handles
request-level access.

**Fork-owned files:** `client/src/features/jobs/components/JobRequestDrawer.vue`,
`client/src/features/jobs/lib/job-subject-route.ts`, their tests, and the route record in
`client/src/router/fork-routes.ts`.

## Convert to M4B overlay (audio conversion)

Joins a book's audio files (usually MP3) into one M4B with exact seeking, embedded chapters, tags and
cover, modelled on Audiobookshelf's "Encode M4B" (`AbMergeManager`): ffmpeg concat list with pinned
`duration` lines, an `;FFMETADATA1` file for tags and chapters, cover as `attached_pic`. Codec Auto
copies the audio when every file shares codec, sample rate and channels, otherwise encodes AAC.
Three entry points: **Tools › Convert to M4B** (batch, `manage_libraries`), a button on the book's
Files tab (also reached from the book ⋮ menu and each audio file's ⋮ menu, which open the Files tab
with `?convert=1`), and **Settings › Library › Audio conversion** (`/settings/audio-conversion`,
`manage_app_settings`), whose "Convert new MP3
books" switch sends a book through fill metadata → fetch chapters → convert. A book the Book Dock
creates with audio enters at once (the dock files a unit only when all its files are in place);
books the scanner finds or that are uploaded straight to a library enter 10 minutes after their
last MP3 is added. A dock unit that only joins an existing book does not start it.

The book keeps its first `book_files` row (asset id, progress, bookmarks survive). In one
transaction the row becomes the M4B, `audiobook_progress` and audio bookmarks and stored chapters move from the stored
timeline (plain running sum of whole-second `duration_seconds`, as the manifest and players use) to
the exact one (a single file moves nothing), `reading_progress` keeps each user's newest row, every
other single-column FK to `book_files.id` is re-pointed to the kept row (found from `pg_constraint`,
each in a savepoint that tolerates only unique violations), and
the merged rows are deleted with `deleteBookFilesWithHashInvalidation`. Originals are copied to
`<APP_DATA_PATH>/audio-convert/backups/<bookId>-<jobId>/` first and deleted after `backup_days`.
Phones that downloaded the old files must download again (positions key changes).
The job records its swap phase, final path, hash and backup before the rename, so `recover()` on boot
either finishes a committed swap or rolls an uncommitted one back. The book lock
(`FileLockService`, `bookOperationLockKey`) is held only for the backup and swap; the listening and
library-scan checks run again under it, and a failed check requeues the job.

**Owned (fork-only) files - never conflict:** `server/src/modules/audio-convert/` (module, bootstrap
SQL, repository, converter, queue, pipeline, controller, DTOs, tests), `server/test/audio-convert.e2e-spec.ts`,
`packages/types/src/audio-convert.ts`, `client/src/features/audio-convert/`. Schema:
`audio_convert_settings`, `audio_convert_jobs`, `audio_convert_watch`, created by
`AudioConvertSchemaBootstrapService` (idempotent SQL, `onModuleInit`), never Drizzle migrations.

**Seams / hooks in upstream files:**

| Upstream file                                                                                                                                                     | Hook                                                                                                                                                    | Conflict cost                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `book_files` (database trigger)                                                                                                                                   | Bootstrap-owned `audio_convert_book_files_added` (AFTER INSERT) depends on `book_id`, `role = 'content'`, `format`                                      | No upstream source edit; verify columns on merge |
| `book_metadata_fetch_queue`                                                                                                                                       | Inserted directly (`manual_trigger`, `ON CONFLICT DO NOTHING`) and read for status; same semantics as `BookMetadataFetchQueueRepository.upsertSchedule` | Verify statuses/reasons on merge                 |
| `ChapterEditorService.bulkLookup`, `AudioPlayOrderService`, `FileWriteRepository.loadPayload`, `BookCoverStore.resolve`, `MetadataService.aggregateAudioDuration` | Called as-is (all already exported)                                                                                                                     | Signature changes break the build                |
| `book-dock/book-dock-events.service.ts`                                                                                                                           | `BOOK_DOCK_BOOKS_FILED` event constant                                                                                                                  | 1 line + doc, additive                           |
| `book-dock/book-dock-finalize.service.ts`                                                                                                                         | after a unit is filed, emits `BOOK_DOCK_BOOKS_FILED` with the books it created and gave audio to                                                        | 3 lines                                          |
| `upload/upload-processor.service.ts`                                                                                                                              | `UnitBookRecords.audioBookIds` (the set `createUnitBookRecords` already builds)                                                                         | 3 lines                                          |
| `book-dock/book-dock-finalize.service.test.ts`, `upload/upload-processor.service.test.ts`                                                                         | filed-event and `audioBookIds` cases                                                                                                                    | test only                                        |
| `app.module.ts`                                                                                                                                                   | import + register `AudioConvertModule`                                                                                                                  | 2 lines, additive                                |
| `packages/types/src/index.ts`                                                                                                                                     | `export * from "./audio-convert"`                                                                                                                       | 1 line, additive                                 |
| `book-consolidation/book-merge-fork-rules.test.ts`                                                                                                                | rules for `audio_convert_jobs.book_id`, `audio_convert_watch.book_id` + participant wiring row                                                          | test only                                        |
| `client/src/router/index.ts`, `features/tools/components/ToolsHeader.vue`                                                                                         | `tools-convert-m4b` route and tab                                                                                                                       | ~10 lines                                        |
| `client/src/features/book/components/detail/files/FilesHeroBar.vue`, `tabs/FilesTab.vue`                                                                          | `actions` slot; FilesTab fills it with `AudioConvertBookButton`, and passes `can-convert` / `@convert` to `FileListCard`                                | ~15 lines                                        |
| `client/src/features/book/components/detail/files/FileListCard.vue`                                                                                               | `canConvert` prop, `convert` emit, one ⋮ menu item before Delete                                                                                        | ~8 lines                                         |
| `client/src/features/book/components/detail/tabs/DetailsTab.vue`                                                                                                  | `AudioConvertMenuItem` in the ⋮ menu, gated by `useAudioConvertVisible`                                                                                 | ~6 lines                                         |
| `client/src/features/settings/lib/settings-nav.ts`, `client/src/router/index.ts`                                                                                  | `audio-conversion` nav item (Library group) and `settings-audio-convert` route                                                                          | ~15 lines                                        |
| `client/src/router/guards/auth.guard.ts`                                                                                                                          | awaits `useAudioConvertEnabled().load()` (cached) for `manage_libraries` users so the tab and button never pop in                                       | 2 lines                                          |
| `client/src/locales/en.json`                                                                                                                                      | `audioConvert.*` keys                                                                                                                                   | additive                                         |

**Plugin removal:** drop `AudioConvertModule` from `app.module.ts` (it imports `BookDockModule` for
the filed event), delete the owned files, revert the seams above, and drop the two rows from `book-merge-fork-rules.test.ts`. Drop the trigger with
`DROP TRIGGER IF EXISTS audio_convert_book_files_added ON book_files` (otherwise every new MP3 row
writes to `audio_convert_watch`); the tables can then be dropped or left alone.

## Cover thumbnail backfill

Upstream makes a slot's missing `thumbnail.jpg` on the first request for it (`repairThumbnail`,
four at a time). A library grid that scrolls past many such books waited seconds per cover while
large originals were resized. `CoverThumbnailBackfillService` walks every served slot (not
dormant, not a placeholder) in primary-key pages of 500, two minutes after boot and daily at 04:30,
and makes each missing thumbnail one at a time through `BookCoverStore.ensureSlotThumbnail`, the
same de-duplicated repair a request uses. It logs `[cover.thumbnail_backfill]` start and end with
`scanned`, `missing`, `made` and `unresolved` (a slot with no readable cover).

**Settings › Fork › Cover thumbnails** (`manage_app_settings`): a switch for the start-up and daily
runs (on by default; turning it off stops a run that is going) and Run now, which works with the
switch off. The page shows the running counts, polled every 2 s, and the last run. Both live in
`app_settings` under `fork_cover_thumbnail_backfill_enabled` and `fork_cover_thumbnail_backfill_last_run`
(JSON), so no schema. API: `GET` / `PATCH {enabled}` `/api/v1/cover-thumbnails/backfill`, `POST .../run`.

New thumbnails are encoded at quality 80 with mozjpeg's trellis quantisation, overshoot deringing
and quantisation table 3, about 38% smaller than the old quality 90 output on real covers. sharp's
`mozjpeg: true` is not used because it also turns on progressive output, which some OPDS clients
cannot decode (upstream #782). Existing thumbnails are left as they are.

**Owned (fork-only) files:** `server/src/modules/cover-thumbnails/` (module, service, repository,
controller, DTO, tests), `server/src/modules/book-cover-store/book-cover-store-ensure-thumbnail.test.ts`,
`server/src/modules/metadata/lib/cover-thumbnail-encoding.test.ts`, `packages/types/src/cover-thumbnails.ts`,
`client/src/features/cover-thumbnails/`. The repository reads the fork's own
`book_cover_placeholders` schema from `book-cover-store/schema/`.

**Hooks in upstream files:** `book-cover-store.service.ts` (public `ensureSlotThumbnail`, a
pass-through to `resolveSlotArtifact`), `metadata/lib/cover.ts` (`THUMBNAIL_JPEG_OPTIONS`),
`app.module.ts` (module registration), `packages/types/src/index.ts` (one export). Fork-owned files
touched: `ForkSettings.vue` (the section), `fork-settings-nav.ts` (search keywords), `en.json`
(`coverThumbnails.*`). The first two hooks are generic and good candidates to propose upstream.

## Book Knowledge overlay (in progress, branch `claude/book-knowledge-v2`)

Spoiler-safe term lists, evidence passages, cards and questions, cut at the reader's position,
plus an admin-run X-Ray build. Ported on 2026-11-20 from the `claude/concept-index`
worktree onto `monitored` after the v3.9.0 merge. The index builds without the GLiNER model (plain
mode); GLiNER is planned to move to its own worker container, so the in-server ONNX code is
temporary. The main image stays on Alpine.

**Index lifecycle.** One index row per book in `book_knowledge_index`; the artifact (gzip JSON)
lives under `APP_DATA_PATH/book-knowledge/<bookId>/<fingerprint>/`. Book Knowledge uses upstream's
`storyGuideFiles` ranking to choose the same file as the Story guide card. The fingerprint is
sha256(`fileHash:size`) of that file, or sha256(`nohash:size:mtimeMs`) when it has no hash, so the
file is never read to fingerprint it. A changed fingerprint makes the row stale and
queues a rebuild; there is no `book_files` delete trigger (bootstrap SQL drops the old one), and
`cleanup()` removes directories whose fingerprint is no longer current (all of them once the row is
gone), one book at a time. A
`ready` row whose artifact cannot be read, or whose `formatVersion` is not `ARTIFACT_VERSION`, is
logged (`[book_knowledge.artifact_read] [fail]`), queued and reported as `queued`. Artifacts are
capped at 512 MiB on read and write; a larger one fails the build with "Book is too long for Book
Knowledge" and Build does not requeue it. The in-memory artifact cache holds 300 MB. The GLiNER
stage gives up after 20 minutes, checked between windows, and stores empty model votes so the
book is not retried forever. The settings row keeps only `enabled`: when off, Build returns 503,
nothing is auto-queued, the drain leaves queued rows alone, and status carries `enabled: false`.
Percentage-only positions are cut by spine item bytes (`artifact.spineBytes`, what Foliate's
`SectionProgress` weighs), never inside an item past the reader. On a book merge the participant
deletes the source book's index, cards and kind reviews only; the kept book keeps its rows.

**Reader model calls.** All calls go through upstream's AI layer as the AI feature
`book-knowledge` (fast slot, `perReader: true`), so they land in `ai_usage` and obey upstream's
budget, limiter and switch. `BookKnowledgeModelService` wraps `AiClient`; card and ask check the
per-reader monthly cap first (`checkReaderCap`, the ledger's `readerSpend`, copied from
reading-help), pass `userId`, and abort on a 60 second timeout or when the reader hangs up. Both
routes carry `@Throttle` like reading-help. Errors: 429 with `errorCode` `budget` or `reader-cap`
(the shape upstream's `GlobalExceptionFilter` keeps), 503 when the model is off, rate limited,
down or timed out, 502 otherwise. Ask retrieval is words only (BM25 plus named-term passages).

**X-Ray build** (`book-knowledge-xray.service.ts`, `xray/`). Turns the index into upstream's
`StoryGuidePayloadV1` plus fork-only `links` and `chronicle`, every item anchored at the sentence it
cites. Started through the admin route `book-knowledge/xray/runs` (`ManageAppSettings`, used by
the bench): POST starts, GET polls, `DELETE :id` cancels (status `failed`, error `cancelled`),
`GET :id/payload` reads. One build at a time; runs live in memory (last four). Steps: the LLM kind
review, entities without a model, then the dense pass (`xray/dense/`): pattern and identity merges,
an alias ask, then each unit (a chapter or part of one) cut into chunks of 100 numbered sentences,
each chunk getting three low-effort asks at once: notes and summary, facts (abilities, merges,
`is` phrases), and a scene ask (point of view, same-as pairs, up to 12 relations). There is no
separate pair or tie-type step. A unit launches once the unit `DENSE_UNIT_WINDOW` (2) places before
it is processed, with at most 8 hosted calls in flight. Each entry's description follows its tier
(main, supporting, minor) with one hard cap of 100 words (`xray/xray-tiers.ts`); descriptions and
`now` lines that name someone their evidence never names are dropped. The description pass labels
preceding sentences as context and excludes them from grounding and citations. It retries shared
descriptions once after more mentions. Fiction descriptions check quoted and bracketed term names
for garbling. Entries eligible for `about` updates can refresh once at least five new mentions
match or exceed the previous mention count, with up to three new timeline notes. Fiction About
prompts preserve the first three identity facts for fact-based main and supporting rows alongside recent
facts, with at most eleven distinct notes. About asks for flowing prose, and Now asks for one sentence
about the current situation. Both reject comma lists and stat numbers, with one rewrite for About
updates and retention of the previous line for rejected Now updates. A run has a mode, fiction or
nonfiction: the run's `mode` override, else one `mode` step call (`xray/xray-mode.ts`, unit `m1`,
stored and replayed like the other steps) on the fast slot that sends the title, authors, blurb,
subjects and the first 2,500 body words, else EPUB subjects or Kindle catalog genres when the call
fails or stays unreadable after one retry. The run records `modeSource` (`override`, `model` or
`subjects`) and the payload carries `mode` and `modeSource`. A dry run plans the call and keeps the
subject mode. `XRAY_MODE_VERSION` is a `BK_PROMPT_VERSION` part.
**Junk judge** (`xray/xray-role-review.ts`). After kind review and cast selection, every admitted
entry except the narrator, characters included, is labelled keep, minor or junk by the fast slot:
batches of about 12 cut at stable hash points of the sorted term keys (so one changed entry re-asks
only its batch), each with up to 5 passages and the cast names that overlap it, 3 votes at
temperature 0.7. Fiction and nonfiction have their own prompts (`EVERYDAY_OBJECT_REVIEW_VERSION`,
`NONFICTION_ROLE_REVIEW_VERSION`); story-system words (stats, skills, classes, ranks, spells) are
keep, and nothing is judged by the words in its name. Tally: 3 of 3 junk removes, 2 of 3 asks 2 more
votes and removes at 4 of 5; a character needs every vote junk (5 of 5 after escalation); 2 minor
votes mark the entry minor. A missing vote counts as keep, but more than a third missing fails the
build as `low-coverage`. Only `bad-request` refusals are downgraded to an unreadable answer; pause
codes (`provider-down`, `budget` and the rest) reach the job engine, and so does the mode call's.
Fused names (an entry that only joins other character or group entries) are dropped before fragment
pruning, names that differ only by case, spacing or punctuation fold into the more mentioned
spelling, and the merge step never joins a fused name to one of its parts. A whole name rejected
by the name check is kept when a part would otherwise stand alone as its fragment. Mentions nested
inside a longer name do not vote on the shorter name's kind.

**Embedded text and the narrator.** `epub-text.ts` marks `inset` sentences: blockquotes and runs of
3 or more `<p>` with a class other than the spine's most common one (letters, emails, logs). The
narrator's detection, introductions and description evidence skip them, and the notes, facts,
scene, describe and about prompts wrap them as written text whose "I" is its writer. The stand-in
narrator joins a character only once settled (6 chunk votes and 3 times the runner-up; the blurb
counts toward the lead only); a section whose own votes all name one person is credited to that
person without a join. First-person chunks no longer wait on each other for the narrator.

**Disclosure timing.** A join's ordinal is the latest link on its chain, so a member is filed
under a head only from the point the reader can know it; prompts resolve members as of the unit's
end. Alias joins wait until their cited sentences are reached, facts merges need a second vote
through the scene guards, epithet folds anchor at an identity sentence or where the pairing
holds, and a typed tie unlocks at its latest cite. Title holders need 3 times lift over the
holder's share of body sentences, or an explicit "Captain Zoey" form.
`dryRun: true` only plans and estimates. Finished answers are kept in `xray-units.jsonl.gz` beside
the artifact, keyed by fingerprint, prompt version, model and request hash (which carries the
connection id and the effort sent), and replayed by later runs. A finished build compacts the file
to the answers it replayed or stored. A cut or corrupt file is marked damaged and rewritten on the
first save; an empty one is just empty. The text and terms stage files are read up to
`ARTIFACT_MAX_BYTES`, and a corrupt one (bad gzip, bad JSON, over the limit) is rebuilt from the
source instead of failing every retry. A build holds its book against `cleanup()`. Each run has one
`AbortController`: on
failure or cancel every launched call is aborted, the store is closed so no late answer lands, and
the guard is released only after all calls settle. Bench payloads live in memory with their runs.
The reader route `GET books/:bookId/knowledge/xray` (`@ResolvesMergedBook`) serves the format 1
story-guide row for the selected Book Knowledge file using upstream's book access checks.
It returns 404 unless the selected file has a stored guide with a `links` array.
The payload is position-stamped; the viewer cuts it client-side. It reuses upstream's
`NAMES_SYSTEM`, `LINES_SYSTEM`, `TIES_SYSTEM`, `SUMMARIES_SYSTEM`, line checks, name-word lists,
`storyGuideTieType`, `flattenWithOffsets` and `readBookText` by import, without editing them. The
shared run type still has `tieVote` and `passRepeats` for the external viewer; nothing sets them.

Fiction cast selection drops undefined dictionary vocabulary and single-section lowercase terms, folds
descriptive names into existing entry names, and requires a one-off capitalised name to act or speak.
Comparisons and dialogue-only forms of address supply no cast evidence. Descriptions attribute
hypotheticals to the character thinking them. The minor-character writer sees accepted timeline notes
through the end of its own unit before the sampled sentences.

Fiction About and Describe share guidance on lasting details by kind. Passing moments stay out of
descriptions and identity facts. Major events can still define a place or creature. About and Describe
headers use the payload's stat and skill detection with evidence through the current unit. The dense
prompt version invalidates cached answers so the next build uses the updated rules.

**Client.** `features/book-knowledge/` owns the panel and `KnowledgeReaderHost.vue`, which holds
the panel state, the visit bar and the navigation handlers; `ReaderView.vue` only renders it and
pauses tracking during a visit.

**Single instance.** The index build queue (`drain`) and the X-Ray guard are in-process. Two server
instances on one database would build the same queued book twice. BookOrbit runs as one container,
so this is accepted; revisit if it ever scales out.

**Owned (fork-only) files:** `server/src/modules/book-knowledge/` (bootstrap SQL schema, no Drizzle
migration; its own `book-knowledge.config.ts` for `BOOK_KNOWLEDGE_GLINER_THREADS`),
`server/scripts/book-knowledge-*`, `server/scripts/gliner-parity.*`,
`client/src/features/book-knowledge/`, `packages/types/src/book-knowledge.ts`.

Initial overlay measured 2026-11-24 with `git diff -w HEAD --stat` on the uncommitted branch
(17 upstream source files, 91 lines added + removed). On 2026-11-25 the two file-selection hooks in
`book.repository.ts` and `book-read.service.ts` moved into `BookKnowledgeRepository.knowledgeFileCandidates`,
following upstream's `StoryGuidesRepository`, which also reads book tables from its own repository. Both upstream
files are back to upstream for Book Knowledge; `book-read.service.ts` keeps 5 added lines for the separate edition sync hook.

| Upstream file                                                                                                                    | Hook                                                                                                                               | Footprint |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `client/.../reader/ReaderView.vue`                                                                                               | import, template ref, `trackingEnabled` line, `closeAnyPanel` branch, toggle, render host                                          | 27 lines  |
| `client/.../epub/components/ReaderHeader.vue`                                                                                    | `knowledgeAvailable` prop, `toggleKnowledge` emit and button                                                                       | 14 lines  |
| `client/src/features/tts/TtsAdminSettings.vue`                                                                                   | admin settings section behind the `book-knowledge` feature flag                                                                    | 5 lines   |
| `server/src/app.module.ts`                                                                                                       | module registration                                                                                                                | 2 lines   |
| `server/src/config/env.validation.ts`, `server/.env.example`                                                                     | `BOOK_KNOWLEDGE_GLINER_THREADS` (read by the module's own config, not `config.ts`)                                                 | 3 lines   |
| `server/package.json` (+ lockfile)                                                                                               | `onnxruntime-node` (1.31.1, see below), `tokenizers`, `wink-nlp`, `wink-eng-lite-web-model`                                        | 4 lines   |
| `packages/types/src/app-info.ts`, `index.ts`                                                                                     | `book-knowledge` server feature, one export                                                                                        | 3 lines   |
| `packages/types/src/ai.ts`                                                                                                       | `book-knowledge` in `AI_FEATURES` and `AI_FEATURE_DEFINITIONS` (`perReader: true`)                                                 | 10 lines  |
| `client/src/features/ai/lib/ai-settings-ui.ts`                                                                                   | `book-knowledge` icon in `FEATURE_ICONS` (and its import)                                                                          | 3 lines   |
| `server/src/modules/ai/ai-client.types.ts`, `ai-adapter.interface.ts`, `ai-client.service.ts`, `adapters/openai-chat.adapter.ts` | optional `temperature` on the request, passed to the chat adapter; unset still sends 0, Book Knowledge sends 1 (0 for kind review) | 6 lines   |

Also touched: `openai-chat.adapter.test.ts` (one test for the temperature hook), `ReaderHeader.spec.ts`
(one test), `en.json` (`bookKnowledge.*`, and the `book-knowledge` AI feature's names, privacy text
and usage label next to upstream's features), `ai.setup-flow.test.ts` (the AI card's row count, 4 to
5, because the new feature adds a slot row), five upstream tests (`ai-budget.service.test.ts`,
`ai-client.service.test.ts`, `ai-client.stream.test.ts`, `ai-connection-test.service.test.ts`,
`reading-help.service.test.ts`: one line each, the `'book-knowledge': defaultFeatureSettings('book-knowledge')`
entry in their `AiFeatureSettingsMap` literal) and the fork-owned `book-merge-fork-rules.test.ts`
(`drop-derived` rules and participant).

`onnxruntime-node` stays on the read-aloud worker's version (1.31.1, 2026-11-25). Version 1.24.3
pulled in `adm-zip` 0.5.18, which fails the image Trivy gate; bump the two together.

Why the five test lines and not a type-level fix: making the key optional in
`AiFeatureSettingsMap` (`ai-settings.service.ts`) would type every `features[id]` read as possibly
undefined and need guards at four non-test upstream sites (`ai-budget.service.ts` twice,
`ai-admin.service.ts` twice), a larger and riskier footprint than five test-literal lines. On a merge
that touches those literals, keep the entry; if a test literal is rewritten to spread over
`AI_FEATURES`, drop it.

## Book Knowledge as the story guide

Build and Update on the Story guide card run Book Knowledge (BK) through upstream's AI job engine.
The pipeline has one `bk` step on the `fast` slot and one unit per book. The runner waits for the
BK index and a shared build slot, honours job cancellation and reuses the BK unit cache within one
job generation: the runner passes `String(ctx.job.generation)` as `buildForStoryGuide`'s `replayScope`,
which joins every stored answer's request hash, so Continue, Retry and Update replay while Rebuild asks
the model again (a finished build compacts the unit file to its own generation; the bench passes no scope). Build
calls go through `ctx.complete`, so the job's recorded model, cost tracking and story-guide budget
apply. The admin bench runs independently of the job engine and shares the build code.

**Switches.** `BkStoryGuideFeature` extends upstream's `StoryGuideFeature` and is provided under its token
after upstream's provider (the later provider wins, as for the estimator). Its `check` refuses with `off`
while BK's own switch or its AI feature row is off, and with `unreadable` for a file BK does not build
from; otherwise it calls upstream's `check`. The engine therefore never creates or retries such a job.
The runner keeps its own checks for jobs queued before a switch changed. A pause with `off` was rejected:
`AiJobPauses.blocker` only reads the story-guide switch, so the minute sweep would resume and re-pause the
job forever. For the status, the subclass implements `buildable()`, declared as an optional member of
`StoryGuideFeature` by module augmentation in `bk-story-guide-feature.ts`; upstream's `statusFor` reads it
in one line, so Build is not offered (reason `off`) while BK is off. The card and the tab then show
upstream's "story guides are turned off" copy, since the status cannot tell the two switches apart.

**Build progress.** `AiStepContext` carries an optional `progress(phase, done, total)` that `runUnit` passes
to the lease-guarded `AiJobRepository.setProgress` (a write after pause, cancel or takeover is a no-op).
BK's `buildForStoryGuide` takes an optional `onProgress(stage, done, total)`: `kinds` per review batch,
`alias` before the dense pass, `dense` from `runDense`'s `onUnit` (0 of n, then after each unit), and
`finish`. `BkStoryGuideProgress` maps these onto upstream's phase names (`text` and `names` from the index
wait, `review`, `lines`, `assemble`), writes a phase change at once, the same phase at most once a second
and the last unit always, and skips a write equal to the last one (the index poll repeats itself). The newest
dropped value lands when the second is up, on an unref'd timer, and `settled()` flushes it before the build
returns, so no timer outlives the build. Writes are chained in order and a failed write is swallowed. Upstream's card, the Jobs
page and the tab read the same phases. Minutes left is timed in memory by the running build from its last
four description chunks, shown only in `lines` after three chunks; another server answering the poll
shows none. Only the one-unit `bk` step may call `progress`: a step with parallel units would fight the
engine's own counter. The two BK hooks (`onUnit` in `xray/dense/dense-run.ts`, `onProgress` in
`book-knowledge-xray.service.ts`) belong to the Book Knowledge session's files; keep them on rebase.

**Coverage.** The engine sees one unit, so its 0.9 floor never fires; BK measures its own.
`buildForStoryGuide` lowers the payload's `coverage` to the lowest share of units that returned a valid
answer over `BK_COVERAGE_STEPS` (kinds, notes, facts, describe, ties; an empty alias, now or about result is
normal), counting steps with at least `BK_COVERAGE_MIN_UNITS` (10) units, and a smaller step only when
less than half of it answered, both exported from `book-knowledge-xray.service.ts`. A refused or filtered
unit is skipped after one try and counts against it. Junk judge units are excluded from kind coverage;
the judge has its own missing-vote floor. The runner fails the job as
`low-coverage` below `AI_JOBS_MIN_COVERAGE`, so the stored guide is kept.
Assembly uses the lower of the engine's and BK's coverage, falls back to engine coverage for missing or
non-finite cached BK coverage, and clamps the payload coverage to [0, 1]. The engine writes
`ai_artifacts.coverage`, which the status, the card's "whole book" label, the admin list and the
`completed` activity read, so `AiFeature` has an optional `coverageOf(artifact)` hook: the runner stores
`Math.min(coverage, run.feature.coverageOf?.(artifact) ?? 1)`, and `BkStoryGuideFeature.coverageOf` returns the
payload's finite `coverage` clamped to [0, 1], or 1 when it is missing or non-finite. The hook can only
lower the engine's value and is inert for a feature without it. A build's `[book_knowledge.xray]` log
reports a pause or the job's abort as `[end] outcome=paused|cancelled`, not `[fail]`.

**Source and estimates.** BK indexes the file upstream's card picks and rejects jobs for another
file of the same book. `buildForStoryGuide` takes the job's `fileId` and fails as `unreadable` when the
file it resolves after the index wait and build slot is another one, so a guide never lands under the
wrong text key. The job path reads `context` with `required = false`, so a switch to a file without a ready
index still reports `unreadable`. If the source lookup throws a `BadRequestException`, the job reports
`unreadable` with the exception's message. The same file without an artifact fails as `error`. Bench builds
and plans propagate source errors and require a ready index. EPUB and KEPUB retain the existing extractor.
MOBI, AZW3 and AZW use upstream's `readBookText` with BK sentence splitting. Estimates use a dry-run plan when the index is
ready. Planning reads the index without queueing it or taking the build slot. A failed plan (no BK
model, say) is kept for `BK_PLAN_FAILURE_TTL_MS` and answered as already failed, so status polls neither
retry it nor log it again. When planning is unavailable, `BkStoryGuideEstimator` prices upstream's estimate across the `fast`-slot entries of
`STORY_GUIDE_STEP_COSTS` (BK runs on Fast only, so an unpriced Careful slot cannot null the quote) at `BK_ESTIMATE_FALLBACK_FACTOR` (1, measured on one live build; figures beside the constant) and
preserves unknown values. Upstream's `StoryGuideFeature.estimate` reaches it through the swapped
`StoryGuideEstimator` token, so the pipeline carries no estimate hook. The `bk` step fingerprint
leaves out `BK_PAYLOAD_VERSION`: a payload bump only re-assembles from the cached `bk` result.

**Storage and serving.** The engine stores the format 1 result in the usual story-guide
`ai_artifacts` row under upstream's `textKey`. Assembly projects chronicle `about` entries into
`profiles` for entities and joins, retains BK extras such as `chronicle` and `links`, and sets
`chronicle.basis` to `builtAt`. The mobile, Absorb and BK reader routes read the same row. Older
upstream guides remain readable by mobile and Absorb until rebuilt. The BK pipeline name marks
those guides as eligible for Update. At serve time `rewriteBkExtras` runs after upstream applies
reader fixes. It updates `about` from the fixed profiles and reconciles chronicle keys, pairs and
links. Fixes keyed to old upstream entities may become orphans after a BK rebuild. The rewrite runs in
the three fork readers (Absorb content route, recap, BK reader) through `bkGuideContent`, after
`StoryGuidesService.content` returns, so upstream's service is untouched. The ETag comes from the stored
hash and the fixes revision, so rewriting the body keeps conditional requests right. Upstream's own mobile
route serves the fixed guide without the extras rewrite; it does not read the extras.

**Versions.** `BK_PROMPT_VERSION` is a 31-bit FNV-1a hash of the nine BK versions it depends on, in
order (dense prompt, kind review, kind spans, text, terms, artifact, mode, fiction and nonfiction
junk judge), so any bump changes it and it stays a safe integer however large a part grows. Indexes for
MOBI, AZW3 and AZW mark as `body` only the sentences inside upstream's `storySections` (the rest is
`front` before the first story section, `other` after); ordinals and spine bytes still cover every linear
section. `TEXT_VERSION` was not bumped: Kindle indexes did not exist before this branch, and a bump would
mark every EPUB index stale. Delete Kindle index rows built before this change by hand.

**Index wait.** A job waits up to `BK_INDEX_TIMEOUT_MS` (45 minutes) for the BK index while holding one
of the engine's build slots. Behind a long BK index queue that slot is idle; a queue-position check is a
later change.

**Plugin removal:** in `story-guides.module.ts`, drop the fork import, `BkPipelineModule` from `imports` and
`...bkStoryGuidePipelineProviders`; revert the `buildable` line in `story-guides.service.ts` and the
`progress` and `coverageOf` hooks in `ai-feature.ts` and `ai-job-runner.service.ts` (optional, harmless if kept); then
unregister `ForkStoryGuideModule`. This is an accepted exception to rule 7: upstream's story guides
module imports fork code directly, as the spec approved, so unregistering the fork module alone leaves
the BK pipeline live.

**Owned (fork-only) files:** `server/src/modules/fork-story-guide/bk-pipeline/` owns the pipeline,
runner, estimator, assembly and extras rewrite. `server/src/modules/book-knowledge/` owns the index,
source selection and shared X-Ray build. `server/src/modules/fork-story-guide/bk-xray-reader.controller.ts`
serves the BK panel and, like the fork content route, is `@InteractiveOnly()`. The upstream hooks are listed in the current conflict surface above.

**After an upstream merge:**

1. Check `storyGuidePipelineName` and its arguments. The BK step and assembly versions must feed
   the same name used for the stored pipeline and the card's Update check.
2. Check `STORY_GUIDE_STEP_COSTS` and the `StoryGuideEstimator` constructor, `estimate` and
   `minutesLeft` signatures. The fallback uses the upstream costed steps on the `fast` slot. Keep
   `...bkStoryGuidePipelineProviders` after upstream's `StoryGuideEstimator` in the module's
   `providers` array so `BkStoryGuideEstimator` wins that token. The guard in
   `bk-story-guide-pipeline.module.test.ts` pins this ordering and wiring.
3. Check `StoryGuidesService.content` and `fixes.apply` signatures. Keep the extras rewrite after
   reader fixes (`bkGuideContent`), and verify the three fork readers still use the service's access
   checks and return its body. Recheck ETag and conditional responses on the Absorb route.
4. Check `StoryGuideFeature`'s constructor and `check`: `bkStoryGuidePipelineProviders` builds the
   subclass with the same arguments, and `statusFor` still passes `buildable` into `buildReason`.
5. Confirm `AiStepContext` and `runUnit`'s context literal still carry `progress`, that `assemble` still
   stores the lower of its coverage and `coverageOf`, and that
   `storyGuidePhase` still maps `text`, `names`, `review`, `lines` and `assemble`. If upstream adds its
   own in-unit progress, delete ours and adapt `BkStoryGuideProgress`.

## Remote read-aloud worker: local work folders

A native worker on another machine (an Apple Silicon Mac for MLX) shares the job folder with the server
over the network. STAlign makes many small reads and writes there, and each one costs a network round
trip: over Wi-Fi SMB a file create measured 58 ms against 1 ms locally, so a job ran about 5x slower
than on local disk even with bulk copies at 125 MB/s. With `READ_ALOUD_LOCAL_WORK_ROOT` set, a job runs
in `<localWorkRoot>/<jobId>` (split audio, emissions, intermediate EPUBs, stage markers; scratch is
upstream's `<tmp>/read-aloud-worker/scratch/<jobId>` since 2026-11-19, and `tmpDir` defaults beside the local work root) and
only what the server reads is copied into the shared job folder after validation, each file under a
`.partial` name first: `output.epub`, `report.json`, and `processed-audio/`, which edition sync's capture
hashes into the timing index (`edition-sync-index-store.service.ts`). Audio chunks whose size and
modification time match the shared copy are not copied again. The shared `output.epub` and `report.json`
are deleted when a run starts, as the runner does before aligning without local work, so a failed rerun
never leaves the last run's output behind. The event sequence file stays in the shared folder: the
server drops events numbered below what it has seen, and the local cache may be cleared. If the server ever
reads another file from the job folder, add it to `publishOutputs` too. Unset (the default, and the Docker
image) behaves exactly like upstream. The temp folder defaults beside the local root instead of the
shared one.

A local folder is pruned in the background when a later job starts and its shared job folder is
definitely gone (`ENOENT`), never while the shared root itself is missing (an unmounted share) or a
check fails for another reason. The disk check also covers the shared folder, which must hold the
processed audio and an output EPUB that carries it again. The same-folder check and the startup guard
on the temp folder both see through links. An edition-sync rebuild's `index.epub`, which the
server writes into the shared folder, is copied in before the runner starts; a missing one falls back to
full alignment as before, and an earlier attempt's local copy is deleted so it cannot stand in.

**Owned (fork-only) files:** `workers/read-aloud/src/local-work.ts`, `workers/read-aloud/test/local-work.test.mjs`.

| Upstream file                         | Hook                                                                                                                                                                                                            | Footprint |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `workers/read-aloud/src/config.ts`    | `localWorkRoot` field and env parse (`sameFolder` through links); temp folder defaults beside it                                                                                                                | ~18 lines |
| `workers/read-aloud/src/protocol.ts`  | `publishDir` on `RunnerJob`                                                                                                                                                                                     | 2 lines   |
| `workers/read-aloud/src/jobs.ts`      | `runFolders` in `resolve`, `prepareLocalRun` before the job folder is created, seq file in the shared folder, `publishDir` to the runner, a shared-folder disk check (`publishDiskBytes`), a `<work>` redaction | ~35 lines |
| `workers/read-aloud/src/server.ts`    | the startup temp-folder guard also covers `localWorkRoot`                                                                                                                                                       | 2 lines   |
| `workers/read-aloud/src/runner.ts`    | `publishOutputs` after `validateOutput` in both validating stages                                                                                                                                               | 3 lines   |
| `workers/read-aloud/test/helpers.mjs` | passes `localWorkRoot` through to the test worker config                                                                                                                                                        | 1 line    |

**Deploying a remote worker** (what a Mac worker for an Unraid server needed): the server sends absolute
paths and the worker compares them as written, so the library (`/books`) and the job folder
(`/data/read-aloud/jobs`) must resolve on the worker machine. Since 2026-11-19 upstream's
`READ_ALOUD_PATH_MAP` translates the server's paths to local ones, so the macOS `/etc/synthetic.conf`
links to the SMB mounts are no longer needed. Samba must write as the container's `PUID`
(`force user`). macOS SMB multichannel (`mc_on=no` in `~/Library/Preferences/nsmb.conf`) cut uploads
to 4.5 MB/s over Wi-Fi; turning it off restored 125 MB/s.

## Read-aloud audio splits (align patch)

STAlign splits a long audiobook into pieces of at most two hours, and the read-along EPUB carries those
pieces. Every client that maps the read-along onto the source audiobook (upstream's `buildAudioTimeline`,
Absorb) lays the pieces end to end, so a piece must start in the source exactly where the ones before it
end. `@storyteller/align` 0.2.17 (and 0.2.16 before it) breaks that in four ways, all fixed by
`patches/@storyteller__align@0.2.17.patch`:

- A cut found by voice activity (`getSafeRanges`, a file or chapter longer than the limit) ended the
  piece at the start of the longest pause and began the next at its end, so the pause was dropped:
  1.015 s and 2.127 s by the second and third piece of book 3308 (a 21,092 s single-file m4b). The cut
  is now the middle of the pause, shared by both pieces, as STAlign's chapter-mark cuts are.
- `splitFile` stream-copies (`-c:a copy`), which keeps whole packets, so a piece ran past its cut to the
  end of the packet and the next piece repeated that audio: half a frame per cut on average, at every
  chapter cut. It adds up: Century Rain (12 kHz AAC, 389 chapter cuts) was 16.3 s late by its end.
  `processFile` now moves each cut shared by two stream-copied pieces (cuts closer than 1 us count as
  shared) to the nearest packet boundary (`snapToPacketBoundary`, one ffprobe per shared cut, measured
  from the file's own start time; a cut in the last packet moves to that packet's start) before
  splitting and before writing the `.source.json` that records it. A file's first start and last end
  stay put, re-encoded pieces are not snapped, and a chapter that snaps to nothing is skipped without
  breaking the chain. ffmpeg copies packets for `to - ss` in whole microseconds, so `splitFile` rounds
  `-ss` up and `-to` down.
- A PCM demuxer hands out packets from wherever it seeks, so a WAV's packets share no grid to snap to
  (a 600 s WAV with five cuts overran by 275 ms), and a copied FLAC piece keeps the whole file's sample
  count in its header, so three pieces of a 250 s FLAC each claimed 250 s. `splitFile` re-encodes a
  file whose only audio stream is PCM or FLAC to the same codec instead, which is lossless, and each
  shared cut moves to the nearest sample (`snapToSample`): ffmpeg turns `-to` into a duration from
  the first sample it keeps, so a cut between samples dropped one. The pieces' samples are the
  source's, byte for byte. A file with several audio streams keeps the copy.
- ghost-story's VAD decodes into a scratch file named after `Date.now()`, and the files of a book look
  for chapter-cut silences at the same time, so two calls in one millisecond read or delete each other's
  audio: a four-file chaptered book failed 11 runs in 15 with "No RIFF id". `findSilences` now cuts its
  window and runs VAD one call at a time, so a book of many files also holds one window at a time, and
  a cancelled job starts no queued call.

If snapping the cuts of a file would leave a piece ending before it starts (cuts on both sides of a
gap between chapters can snap to the same point), that file is cut unsnapped, with a warning.

Stream copy stays (rather than re-encoding every piece or not splitting) because it is lossless and
fast, and with packet-aligned cuts it is exact. A copied MP3 piece has no gapless header, so it decodes
LAME's 529-sample delay (12 ms at 44.1 kHz) before its audio; the pieces still line up end to end. Not
fixed and older than the patch: on a source whose audio starts after zero, STAlign ends the last piece at
the metadata duration, about one frame short of the decoded end; on a raw ADTS `.aac` file the last
piece stops at an estimated duration, short of the real end; and a copied MP3 piece can open with up to
two frames of silence at a cut, because MP3 frames borrow data from the frames before them.
`AUDIO_PREPARE_VERSION` (in the fork-owned `xhe-aac.ts`) went to 4 so cached splits are redone; a
read-along generated before this keeps its drift until it is regenerated. BookOrbit's own timing indexes
place each piece at its recorded start, so they are not affected.

**Owned (fork-only) files:** `patches/@storyteller__align@0.2.17.patch`,
`workers/read-aloud/test/split-continuity.test.mjs`. Its cases: pause cuts, chapter cuts, a chapter
shorter than a frame, a long chapter cut at a pause, a chapter after such a cut, a mark in the last
packet, audio starting after zero, copied CBR MP3, PCM WAV and FLAC (both compared sample for sample),
a file with two PCM streams, cuts around a gap between chapters, and a book in four files. Each piece is
checked against the source by cross-correlation within 2 ms, and so is its recorded start. A further
case, VBR MP3 (which STAlign re-encodes, so the patch does not touch it), is a regression guard only. All
of them are skipped where ffmpeg is missing.

| Upstream file                   | Hook                                                 | Footprint          |
| ------------------------------- | ---------------------------------------------------- | ------------------ |
| `pnpm-workspace.yaml`           | `patchedDependencies` entry for `@storyteller/align` | 1 line             |
| `pnpm-lock.yaml`                | the patch hash on the align entries                  | generated, 3 lines |
| `workers/read-aloud/Dockerfile` | build fails if the deployed align lacks the patch    | 7 lines            |

**Merge hazard:** the patch is pinned to `@storyteller/align@0.2.17`. When upstream bumps align, the
install fails until the patch is redone with `pnpm patch` on the new version (0.2.16 to 0.2.17 carried
over unchanged once the `@storyteller-platform/` import scope in the context lines became
`@storyteller/`), or dropped if Storyteller fixed all of it. Run `split-continuity.test.mjs` against the
new version without the patch first, and update the Dockerfile check's path and message with it.

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

- Kepubify rebuild recipe (the fork's 2026-11-19 Go 1.27.4 binaries were taken upstream byte for byte
  on 2026-11-24, so there is no divergence): kepubify commit
  `9546034bc023891af5ce30709de6ae2dcf264628`, `go get golang.org/x/sync@v0.24.0
golang.org/x/text@v0.43.0`, then `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"
./cmd/kepubify` per target (`GOARM=7` for linux-arm). Reuse it if a Go CVE fails Trivy before
  upstream rebuilds.
- `client/src/features/book/components/BookListRow.vue`: one line, `:frame-aspect-ratio="coverAspectRatio"`
  on the row's `BookCoverArtwork` (2026-11-19). Upstream sizes the list row's cover box from the book's
  own ratio but lets the artwork fall back to the library's, so a 2/3 cover in a square-cover library is
  drawn at two-thirds width in the natural-bottom display mode. `BookCoverCard.vue` already passes the
  ratio. Drop the line when upstream fixes it; `BookListRow.spec.ts` has the case.
- `client/src/features/jobs/components/JobTableRow.vue`: +23/-1 lines and four `jobsArea.*` keys in
  `en.json` (`open`, `review`, `openOn`, `reviewOn`), 2026-11-19. A Jobs row in Needs you, Failed or Paused
  that offers no action but has a subject URL shows a Review (Needs you) or Open link-button in the lead
  slot. Upstream's request-download and read-along Needs-you rows have no action by design (review lives
  on the request or book page), so the row only led on through a title that underlines on hover. Client
  only, navigation only. Drop it when upstream adds an equivalent; `JobTableRow.open-link.test.ts` has the
  cases.
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
  web reader already emits it for ebooks. Since 2026-11-24 upstream emits a narrower
  `audiobook.progress-changed` there (StoryGraph only); the alternative is to point Hardcover,
  achievements and `scan.gateway` at that event and carry `bookFileId` in it.
- ABS pull: it calls `syncEbookProgressForAudiobookPlayback` and emits `book:progress-changed`, the
  same pair upstream's player does; if upstream ever emits from `putPlaybackState`, both fork emits
  can go.
- Read-aloud worker: `READ_ALOUD_LOCAL_WORK_ROOT` (local work folders for a worker on another
  machine). Any remote native worker hits the per-file network cost; upstream owning it deletes
  `local-work.ts` and the six hooks.
- `patches/@storyteller__align@0.2.17.patch` (also to Storyteller, which owns the code): split
  pieces that keep the pause at a voice-activity cut, cut on packet boundaries (on samples for PCM) and
  run VAD calls one at a time, so the pieces laid end to end match the source audiobook. Upstream's own
  `buildAudioTimeline` drifts without it.

### Edition sync content-file trigger dependency

The edition-sync bootstrap owns `edition_sync_book_files_changed` on upstream `book_files`.
It depends on `book_id`, `role`, `size_bytes`, `mtime`, `file_hash`, and `absolute_path`.
An upstream rename must be reflected in the bootstrap SQL or bootstrap fails loudly.
Content mutations flag only the affected books; the library catalog listener is removed.
`on_files_changed` chooses the next scheduled run (default) or immediate pinning after a
10-minute quiet period. Changed sources discard cached worker work before a fresh claim.

### Edition sync metadata-only source changes

Provenance stays jsonb version 1, with optional `epub.chapterFingerprint`,
`audio[].audioFingerprint`, `chunks[].audioMd5`, and rebuild `chapterFingerprint`.
No schema changes are needed. The scheduler shares a 10-second content-check budget across each
tick; sync lookups never invoke ffmpeg and return off while a fingerprinted mismatch awaits verification.
The server uses typed `audioToolsConfig.ffmpegPath`; STAlign and the worker use ffmpeg on PATH.
The DB provenance owns refreshed source file metadata while the zip retains its capture snapshot.
Verification compares immutable alignment fields, source IDs and fingerprints across both copies.

`workers/read-aloud/src/rebuild-metadata.ts` runs STAlign upgrade and cheap markup and replays
the supported OPF delta onto the current source. Markup preserves the full-run serialization of
image-only cover pages while retaining their current image links. Chapter hrefs and IDs must agree.
Rebuild replay also compares STAlign's chapter classification, so classifier inputs outside chapter
bytes fall back to a full run if the classification changes. Audio-only added chapters alter both
spine and navigation and can derive titles from audio metadata; these, unknown manifest deltas,
and ID collisions fail closed to a full run. The worker ZIP and XML dependencies resolve through
the pinned STAlign/EPUB packages, so recheck their APIs and upgrade/markup/align behavior when
updating those packages. Old indexes retain exact size/SHA256 chunk and source-entry CRC checks.
Metadata replay also requires the fork worker health capability `rebuildMetadata: true`.
An older worker's `rebuild: true` alone is insufficient because its request validator drops the
new fields and could otherwise publish the stored OPF after the DB provenance was refreshed.

The metadata-only shortcut depends on upstream `server/src/modules/file-write`:
`epub-format-writer.ts` and the cover handler touch only the OPF, cover image and
cover page, leaving text-bearing chapter documents byte-identical;
`audio-metadata-embedder.ts` remuxes audio with `-c copy`. If upstream starts rewriting
chapter documents or re-encoding audio, metadata saves will re-index again.
The server and worker audio fingerprint helpers are twins and must change together.
The chapter fingerprint is implemented twice (cheerio on the server, xmldom in the
worker). Both implementations must pass the shared parity fixture at
`workers/read-aloud/test/fixtures/chapter-fingerprints.json`.
