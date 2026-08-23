# Phase 2 - Migration decoupling (implementation spec)

**Goal:** remove all Audiobookshelf schema from Drizzle's migration system and manage
it with an **idempotent boot-time bootstrap**. This takes `_journal.json`, the
migrations folder, `schema/reader.ts` (constraints), and `schema/metadata.ts` (index)
off the merge-conflict surface permanently.

**Context:** we are doing a **one-time DB reset** to land this cleanly, so there is no
live-migration step. After this, the DB is stable and future upstream merges never touch
ABS schema again. The bootstrap is still written idempotently (it runs on every app
boot), and the constraint guards still matter for scale (a large `reading_sessions`
table must not be revalidated on every boot).

## What ABS currently owns in the schema (source of truth: migration 0055)

- **Tables** `audiobookshelf_book_state`, `audiobookshelf_user_settings` (with their
  PK, unique constraints, FKs to `users`/`books`).
- **Indexes** `audiobookshelf_book_state_user_book_idx`, `bm_audible_id_idx`
  (on the **upstream-owned** column `book_metadata.audible_id`).
- **Shared constraint changes** (irreducible - ABS extends upstream enums):
  - `reading_attempts.origin_chk` gains `'audiobookshelf'`.
  - `reading_sessions.source_chk` gains `'audiobookshelf'`.
  - `reading_sessions.source` widened to `varchar(20)`.

## Target design

1. ABS table Drizzle objects still exist (ORM needs them) but are **invisible to
   drizzle-kit** (not reachable from `schema/index.ts`), so `drizzle-kit generate`
   never emits an ABS migration.
2. All ABS DDL lives in one **idempotent SQL bootstrap** run once at app startup,
   after migrations. Re-running is a cheap no-op.
3. Upstream schema files carry **zero** ABS changes.

## Steps

### Step 1 - Idempotent bootstrap (ABS-owned, new files)

Create `server/src/modules/audiobookshelf/schema/audiobookshelf-schema.sql` containing
the DDL below, and a NestJS service that runs it.

**Idempotency rules (critical for a large `reading_sessions` table - do NOT blindly
drop/recreate constraints every boot):**

- Tables: `CREATE TABLE IF NOT EXISTS ...`.
- Indexes: `CREATE INDEX IF NOT EXISTS ...`.
- FKs / unique constraints: guard with a catalog check (Postgres has no
  `ADD CONSTRAINT IF NOT EXISTS`):
  ```sql
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '<name>') THEN
      ALTER TABLE "<t>" ADD CONSTRAINT "<name>" ...;
    END IF;
  END $$;
  ```
- Shared CHECK constraints (`reading_*`): **only modify if the current definition does
  not already allow `audiobookshelf`** - never revalidate a big table on every boot:
  ```sql
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'reading_sessions_source_chk'
        AND pg_get_constraintdef(oid) LIKE '%audiobookshelf%'
    ) THEN
      ALTER TABLE "reading_sessions" DROP CONSTRAINT IF EXISTS "reading_sessions_source_chk";
      ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_source_chk"
        CHECK ("reading_sessions"."source" IN ('web','koreader','manual','kobo','audiobookshelf'));
    END IF;
  END $$;
  ```
  Same pattern for `reading_attempts_origin_chk`.
- `reading_sessions.source` width: guard with `information_schema.columns` -
  only `ALTER COLUMN ... TYPE varchar(20)` if current `character_maximum_length < 20`.

Full column list for the two tables: copy verbatim from
`server/src/db/migrations/0055_audiobookshelf_integration.sql`.

Runner: `AudiobookshelfSchemaBootstrapService implements OnApplicationBootstrap`,
injects the Drizzle `DB`, executes the SQL once (single `db.execute(sql.raw(...))` per
statement, or split on a marker). Log `[abs.schema_bootstrap] [start|end|fail]` per the
project logging convention. Register it in `AudiobookshelfModule` providers.

Rationale for `OnApplicationBootstrap`: in production the migration job runs before the
app starts, so core tables (`users`, `books`, `reading_*`) already exist when the
bootstrap runs. ABS sync is cron-scheduled, so tables exist well before first use.

### Step 2 - Make ABS schema invisible to drizzle-kit

- In `server/src/db/schema/index.ts`, **remove the `audiobookshelf` re-export**.
- Move `server/src/db/schema/audiobookshelf.ts` to
  `server/src/modules/audiobookshelf/schema/audiobookshelf.schema.ts` (out of the
  drizzle schema dir). Update ABS code imports to point there. (Keeping the pgTable
  objects is required - the ORM/queries use them.)
- **Revert `server/src/db/schema/reader.ts`** to upstream: remove `'audiobookshelf'`
  from the `origin`/`source` CHECK definitions and any width change. The DB values are
  handled by the bootstrap; Drizzle's TS type for these columns stays plain string.
- **Revert `server/src/db/schema/metadata.ts`**: remove the `bm_audible_id_idx` index
  definition (handled by bootstrap).

### Step 3 - Remove the ABS migration + regenerate check

- Delete `server/src/db/migrations/0055_audiobookshelf_integration.sql` and its
  `meta/0055_snapshot.json`; remove the `0055` entry from `meta/_journal.json`.
- Delete `0056_backfill_abs_asin_isbn_normalization.sql` too? **No - keep it.** It only
  touches upstream-owned `book_metadata` data; it is not schema-decoupling scope. Renumber
  is unnecessary since it stays. (If journal edits make it the last entry, leave it last.)
- Run `cd server && pnpm db:generate __phase2_check` and confirm it produces an **empty
  or no** migration (proving drizzle-kit no longer sees ABS objects). Delete the probe
  migration afterward.

## Verification (must all pass before commit)

1. `pnpm db:generate __check` → no ABS migration emitted (delete probe after).
2. **Fresh DB (the reset path):** drop schema, `pnpm db:migrate` (core only, no ABS
   migration), boot app → bootstrap creates ABS tables → `npx vitest run
   src/modules/audiobookshelf` green, and the tables/constraints exist (spot-check with
   psql: both ABS tables present, `reading_sessions_source_chk` includes
   `audiobookshelf`).
3. **Idempotency:** boot the app a second time against the now-populated DB → bootstrap
   logs a no-op, no errors, constraints unchanged (guard prevents revalidation).
4. `pnpm build` 0 issues; ABS suite green.

## Delegation

- **Codex:** implements Steps 1-3 (bootstrap SQL + guards + runner service; schema-file
  moves/reverts; migration removal), one step per run, against this spec.
- **Opus (steer):** review every diff, run the Verification section after each step,
  commit. Step 2's upstream reverts get the closest review (they must exactly match
  upstream's original definitions).

## Rollback

The DB is disposable (one-time reset), and the bootstrap is read-before-write, so a
failed run touches nothing - rollback is code-only: restore `0055_*.sql` + its snapshot +
the `_journal.json` entry, and re-add the `audiobookshelf` export to `schema/index.ts`.
