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

Every line the fork changes in an **upstream-owned file** is permanent recurring
tax - it can conflict on any future upstream merge. ABS-only new files cost
nothing. So the strategy is:

1. Keep ABS logic in **ABS-owned files** (the `audiobookshelf` module, ABS schema,
   ABS extractors, ABS client feature dir). These already exist and are conflict-free.
2. Where ABS must reach into an upstream file, prefer a **one-time extension seam**
   (a registry, a DI token, a spread) over inline edits, so future ABS changes touch
   only ABS files.
3. Accept a small, **surgical, well-commented** footprint in the few upstream files
   that are genuinely core-coupled (reading state). Full isolation is impossible -
   progress sync *is* an edit to reading-state code.

## Branch model

- **`audiobookshelf-support` is this fork's `main`.** Set it as the default branch on
  your origin fork. (Consolidate `abs-metadata-json-sidecar` into it - one fork branch.)
- **Merge upstream, never rebase.** Merging preserves fork history and keeps conflict
  resolution incremental.
- **Merge frequently and small.** A 15-commit gap is what made the last merge painful.
  Merge per upstream release (or weekly); small merges = trivial conflicts.

## The merge ritual

Run this every time you pull upstream. Keep it boring.

```
# 1. Fetch and merge
git fetch upstream
git merge upstream/main          # resolve conflicts per the audit below

# 2. Migrations (until Phase 2 lands): take upstream's, regenerate ABS on top
#    (see "Migration strategy" - this step disappears after Phase 2)
git checkout --theirs server/src/db/migrations/meta/_journal.json <colliding snapshots>
git rm <superseded ABS migrations>
cd server && pnpm db:generate abs_integration     # one consolidated ABS migration

# 3. Re-apply seams if an upstream refactor moved them (see audit)

# 4. Verify
cd server && pnpm build                            # source typecheck, expect 0 issues
npx vitest run src/modules/audiobookshelf          # ABS suite must stay green
pnpm test                                          # full suite (note pre-existing fails)

# 5. Commit the merge
git commit
```

Known pre-existing upstream test failures (NOT caused by the fork): the
`published-date.utils` timezone bug (fails at UTC+ offsets), which also fails
`kobo.scraper.test.ts`. Don't chase these during a merge.

## Conflict-surface audit

Snapshot at the time of writing: the fork touches **~45 upstream-owned files**.
Categorized by treatment:

### A. Seam-able - convert to one-time extension points (highest payoff)

These are registration-style edits where ABS adds itself to an upstream list/map.
Add a seam once; then ABS code lives in ABS files.

| Upstream file | +lines | What ABS added | Seam |
|---|---|---|---|
| `metadata/metadata.service.ts` | +176 | sidecar cover logic, extractor wiring | inject extra extractors + move sidecar-cover to ABS |
| `scanner/scanner.service.ts` | +184 | sidecar metadata-source detection/precedence | register "sidecar" as a metadata-source provider |
| `metadata/extractors/audio.extractor.ts` | +82 | ASIN/audible-id extraction from audio | post-extract provider-id hook, or ABS-owned extractor |
| `metadata/metadata-extraction.service.ts` | +3 | JSON sidecar extractor registration | DI token for injected `FormatExtractor`s |
| `metadata/extractors/format-extractor.interface.ts` | +3 | interface shape | the seam interface |
| `metadata/lib/cover.ts` | +12 | `isDecodableImage` helper | keep as shared util (low churn) or move to ABS |
| `scanner/lib/classify.ts` | +5 | recognize `metadata.json` sidecar | source-type registry entry |
| `scanner/scanner.repository.ts` | +11 | sidecar query support | follows the source seam |
| `library/library.constants.ts` | +2 | add `sidecar` to precedence default | precedence extension point |
| `client .../integration-tabs.ts` | +7 | ABS settings tab | tab-registration array spread |
| `client .../IntegrationAllSettings.vue` | +3 | ABS tab render | component registry |
| `client .../LibraryCreatorMetadata.vue` | +11 | sidecar metadata option | options-list spread |
| `client .../useLibraryCreator.ts` | +5 | sidecar option state | follows the above |
| `client .../ReadingLogTable.vue` | +2 | ABS source label | label map entry |

### B. Irreducible - core-coupled, keep surgical

Progress sync and provider IDs genuinely modify shared reading-state/domain code.
Keep these edits small, clustered, and commented so a conflict is a 3-line reconcile.

| Upstream file | +lines | What ABS added |
|---|---|---|
| `user-book-status/reading-attempt.service.ts` | +39 | ABS-origin attempt import/adoption |
| `book/book.service.ts` | +33 | sidecar cover + audio progress reads/writes |
| `book/book.repository.ts` | +45 | sidecar/audible query support |
| `db/schema/reader.ts` | +5 | `audiobookshelf` in source/origin CHECK constraints |
| `db/schema/metadata.ts` | +2 | `audible_id` column on shared `book_metadata` |
| `packages/types/{book,reading-session,permissions,index}.ts` | +2..3 each | union + permission extensions |
| `hardcover/hardcover-import.service.ts`, `reading-attempt.repository.ts`, `db/schema/index.ts` | +2..3 | trivial shared touches |

### C. Cheap / mechanical

| File(s) | Treatment |
|---|---|
| `client/src/locales/{en,de,nl,sl}.json` | i18n keys; conflicts are trivial line adds |
| `db/migrations/meta/_journal.json` | migration journal; **removed from surface by Phase 2** |

### D. Test files (14) - two kinds

- **Coupled to source** (`scanner.service.test.ts` +1215, `metadata.service.test.ts`
  +587, `book.service.test.ts` +135): the ABS assertions are woven into shared tests
  because the *source* behavior changed. These do **not** extract cleanly on their
  own - they relocate as a consequence of the Phase 1 seams.
- **Cleanly separable** (`audio.extractor.test`, `classify.test`,
  `format-extractors.test`, `book.repository.test`, `reading-attempt.service.test`,
  `scanner.repository.test`, and the client specs, ~175 lines total): standalone ABS
  scenarios that can move to ABS-owned test files anytime. Low payoff, do opportunistically.

## Hardening plan (sequenced)

Ordering matters: seams first, because the big test surface only separates once the
source is decoupled.

**Phase 1 - Extension seams** (highest recurring payoff)
- Metadata extractor registration: DI token so ABS registers its JSON-sidecar
  extractor from `audiobookshelf.module`, not inline in the upstream map.
- Sidecar as a metadata-source provider: register `sidecar` via a source registry
  instead of editing scanner detection/precedence inline.
- Client UI registration seams: settings tabs, library metadata options, source labels.
- Consequence: `metadata.service.ts`, `scanner.service.ts`, and their big test files
  drop most of their ABS footprint; ABS tests move to the ABS module.

**Phase 2 - Schema / migration decoupling** (removes the worst recurring conflict)
- Move ABS schema (tables + the shared CHECK-constraint additions) into an
  **idempotent boot-time bootstrap** run after `drizzle migrate`
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, re-assert constraints).
- Removes `_journal.json` and the migrations folder from the conflict surface
  entirely, and is **safe against a live DB** (idempotent, no migration-hash churn).
- Needs a careful one-time transition since ABS tables currently exist via migrations
  on your real DB - plan it separately.

**Phase 3 - Test relocation**
- Move the now-decoupled ABS tests into ABS-owned test files (falls out of Phase 1).
- Extract the cleanly-separable small test files.

**Phase 4 - Ongoing discipline**
- Keep the irreducible edits (bucket B) surgical and clustered.
- Follow the merge ritual; merge upstream small and often.

## Migration strategy (the real-data constraint)

This fork runs a **self-hosted instance with real library data**, so migrations
cannot be freely regenerated (that rewrites applied history). Two viable models:

1. **Interim (current):** on each merge, take upstream's migration state and
   regenerate a single consolidated ABS migration on top (the ritual step 2). Works,
   but every merge changes the ABS migration hash - fine while the DB is disposable,
   risky once data matters.
2. **Target (Phase 2):** ABS schema lives in an idempotent boot bootstrap, fully
   outside Drizzle's journal. Zero migration conflicts, safe for a live DB. This is
   the reason Phase 2 exists.

Until Phase 2, treat the dev DB as disposable when merging (reset + re-migrate).
