import { describe, expect, it } from 'vitest';

import { splitSchemaStatements } from '../../../common/utils/schema-bootstrap.utils';
import { storytellerReadAlongBuilds, storytellerSettings } from './storyteller.schema';
import { STORYTELLER_SCHEMA_SQL } from './storyteller-schema';

const statements = splitSchemaStatements(STORYTELLER_SCHEMA_SQL);

describe('delete_remote_after_import default', () => {
  it('creates the column defaulting to true', () => {
    const createTable = statements.find((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_settings"'));

    expect(createTable).toMatch(/"delete_remote_after_import" boolean DEFAULT true NOT NULL/);
  });

  it('carries the default to a database created while it was false', () => {
    // CREATE TABLE IF NOT EXISTS is a no-op on an installed database, so the new default only
    // reaches one through an ALTER.
    const alter = statements.find((statement) => statement.includes('ALTER COLUMN "delete_remote_after_import"'));

    expect(alter).toBeDefined();
    expect(alter).toContain('SET DEFAULT true');
  });

  it('guards the ALTER so a boot that has nothing to change does no work', () => {
    const alter = statements.find((statement) => statement.includes('ALTER COLUMN "delete_remote_after_import"'))!;

    expect(alter).toContain('information_schema.columns');
    expect(alter).toContain("column_default IS DISTINCT FROM 'true'");
  });

  it('leaves stored row values alone', () => {
    expect(STORYTELLER_SCHEMA_SQL).not.toMatch(/UPDATE\s+"?storyteller_settings"?\s+SET\s+"?delete_remote_after_import"?/i);
  });

  it('agrees with the drizzle column declaration', () => {
    expect(storytellerSettings.deleteRemoteAfterImport.default).toBe(true);
    expect(storytellerSettings.deleteRemoteAfterImport.notNull).toBe(true);
  });
});

// A constraint declared only inside CREATE TABLE IF NOT EXISTS never reaches a database whose table
// an earlier iteration of this file already created: the statement is a no-op there, and there are
// no Drizzle migrations to carry it. For the pair unique that is not cosmetic - startBuild upserts
// ON CONFLICT on those two columns, so every build request on such an install dies at 42P10 forever.
describe('table constraints reach an already-installed database', () => {
  // Every UNIQUE/CHECK the two CREATE TABLE statements declare inline.
  const inlineConstraints = [
    'storyteller_settings_singleton_chk',
    'storyteller_settings_transport_chk',
    'storyteller_read_along_builds_pair_unique',
    'storyteller_read_along_builds_status_chk',
    'storyteller_read_along_builds_phase_chk',
    'storyteller_read_along_builds_transport_chk',
    'storyteller_read_along_builds_remote_progress_chk',
  ];

  it.each(inlineConstraints)('declares %s inline for a fresh database', (name) => {
    const createTable = statements.find((statement) => statement.startsWith('CREATE TABLE') && statement.includes(`CONSTRAINT "${name}"`));

    expect(createTable).toBeDefined();
  });

  it.each(inlineConstraints)('also adds %s through a guarded ALTER for an existing one', (name) => {
    const alter = statements.find((statement) => statement.startsWith('DO $$') && statement.includes(`ADD CONSTRAINT "${name}"`));

    expect(alter).toBeDefined();
    // Guarded on the constraint's absence, and scoped to the table that should hold it: a bare name
    // check can be satisfied by another table's constraint, since names are only unique per table.
    expect(alter).toContain('pg_constraint');
    expect(alter).toContain(`conname = '${name}'`);
    expect(alter).toMatch(/conrelid = to_regclass\('storyteller_(settings|read_along_builds)'\)/);
  });

  it('adds the pair unique on the columns startBuild names in its ON CONFLICT', () => {
    const alter = statements.find((statement) => statement.includes('ADD CONSTRAINT "storyteller_read_along_builds_pair_unique"'))!;

    expect(alter).toMatch(/UNIQUE\s*\(\s*"text_book_id",\s*"audio_book_id"\s*\)/);
  });
});

// Planned for resume staleness detection and never wired: nothing in the module, the client or the
// types package ever read or wrote them, so the columns only cost a wider row and a misleading
// contract doc on startBuild.
describe('read-along build columns', () => {
  it('declares no content-hash columns', () => {
    expect(STORYTELLER_SCHEMA_SQL).not.toMatch(/"(audio|epub)_content_hash"/);
    expect(Object.keys(storytellerReadAlongBuilds)).not.toContain('audioContentHash');
    expect(Object.keys(storytellerReadAlongBuilds)).not.toContain('epubContentHash');
  });
});

describe('target_folder_id on read-along builds', () => {
  it('declares the column for a fresh database and adds it to an existing one', () => {
    const createTable = statements.find((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_read_along_builds"'));
    const addColumn = statements.find((statement) => statement.includes('ADD COLUMN IF NOT EXISTS "target_folder_id"'));

    expect(createTable).toContain('"target_folder_id" integer');
    expect(addColumn).toContain('ALTER TABLE "storyteller_read_along_builds"');
  });

  it('references library folders through a guarded foreign key that nulls on delete', () => {
    const alter = statements.find((statement) => statement.includes('ADD CONSTRAINT "storyteller_read_along_builds_target_folder_id_fk"'))!;

    expect(alter).toContain("conname = 'storyteller_read_along_builds_target_folder_id_fk'");
    expect(alter).toContain('REFERENCES "public"."library_folders"("id") ON DELETE set null');
    expect(Object.keys(storytellerReadAlongBuilds)).toContain('targetFolderId');
  });
});

describe('attached_link_id on read-along builds', () => {
  it('declares the column for a fresh database and adds it to an existing one', () => {
    const createTable = statements.find((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_read_along_builds"'));
    const addColumn = statements.find((statement) => statement.includes('ADD COLUMN IF NOT EXISTS "attached_link_id"'));

    expect(createTable).toContain('"attached_link_id" integer');
    expect(addColumn).toContain('ALTER TABLE "storyteller_read_along_builds"');
    expect(Object.keys(storytellerReadAlongBuilds)).toContain('attachedLinkId');
  });

  it('references edition links through a guarded foreign key that nulls on delete', () => {
    const alter = statements.find((statement) => statement.includes('ADD CONSTRAINT "storyteller_read_along_builds_attached_link_id_fk"'))!;

    expect(alter).toContain("conname = 'storyteller_read_along_builds_attached_link_id_fk'");
    expect(alter).toContain("to_regclass('book_edition_links') IS NOT NULL");
    expect(alter).toContain('REFERENCES "public"."book_edition_links"("id") ON DELETE set null');
  });

  // Rows built before the column existed were attached by their build to a link that predates it or
  // that already carries the output; left null, a read-along detached from such a link would be put
  // back on the next poll. The null guard keeps the statement idempotent across boots.
  it('stamps a legacy ready row with the link that predates its build or already carries its output', () => {
    const backfill = statements.find((statement) => statement.includes('SET "attached_link_id" = l."id"'))!;

    expect(backfill).toContain("to_regclass('book_edition_links') IS NOT NULL");
    expect(backfill).toContain('b."attached_link_id" IS NULL');
    expect(backfill).toContain('(l."created_at" < b."built_at" OR l."read_along_book_id" = b."output_book_id")');
  });
});

describe('cancelled read-along builds', () => {
  const addStatement = () => statements.find((statement) => statement.includes('ADD CONSTRAINT "storyteller_read_along_builds_status_chk"'))!;
  const dropStatement = () => statements.find((statement) => statement.includes('DROP CONSTRAINT "storyteller_read_along_builds_status_chk"'))!;

  it('accepts cancelled in the status check of a fresh database, the upgrade and the drizzle table', () => {
    const createTable = statements.find((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "storyteller_read_along_builds"'));

    expect(createTable).toContain(`CHECK ("status" in ('building', 'ready', 'failed', 'cancelled'))`);
    expect(addStatement()).toContain(`CHECK ("status" in ('building', 'ready', 'failed', 'cancelled'))`);
  });

  // Dropped only while it still lacks the new value, so a boot that has nothing to change does no work.
  it('replaces an older status check idempotently, before the guarded add', () => {
    expect(dropStatement()).toContain("pg_get_constraintdef(oid) NOT LIKE '%cancelled%'");
    expect(statements.indexOf(dropStatement())).toBeLessThan(statements.indexOf(addStatement()));
  });
});
