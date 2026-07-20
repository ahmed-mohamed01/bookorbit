import { AUDIOBOOKSHELF_SCHEMA_SQL } from './schema/audiobookshelf-schema';

describe('Audiobookshelf schema bootstrap SQL', () => {
  it('creates normalized exact-match indexes without repairing book metadata at boot', () => {
    expect(AUDIOBOOKSHELF_SCHEMA_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "bm_audible_id_norm_idx" ON "book_metadata" USING btree (upper(trim("audible_id")));',
    );
    expect(AUDIOBOOKSHELF_SCHEMA_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "bm_isbn10_norm_idx" ON "book_metadata" USING btree (upper(trim("isbn10")));',
    );
    expect(AUDIOBOOKSHELF_SCHEMA_SQL).toContain('DROP INDEX IF EXISTS "bm_audible_id_idx";');
    expect(AUDIOBOOKSHELF_SCHEMA_SQL).not.toContain('CREATE INDEX IF NOT EXISTS "bm_audible_id_idx"');
    expect(AUDIOBOOKSHELF_SCHEMA_SQL).not.toMatch(/UPDATE\s+"book_metadata"/);
  });
});
