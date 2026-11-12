import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODULE_METADATA } from '@nestjs/common/constants';

import { AudioConvertBookConsolidationParticipant } from '../audio-convert/audio-convert-book-consolidation.participant';
import { AudioConvertModule } from '../audio-convert/audio-convert.module';
import { AudiobookshelfBookConsolidationParticipant } from '../audiobookshelf/audiobookshelf-book-consolidation.participant';
import { AudiobookshelfModule } from '../audiobookshelf/audiobookshelf.module';
import { reviveCoverSlots } from '../book-merge/book-merge.executor';
import { EditionSyncBookConsolidationParticipant } from '../edition-sync/edition-sync-book-consolidation.participant';
import { EditionSyncModule } from '../edition-sync/edition-sync.module';
import { MonitoredBookConsolidationParticipant } from '../monitored/monitored-book-consolidation.participant';
import { MonitoredModule } from '../monitored/monitored.module';
import { ReadingAlignmentBookConsolidationParticipant } from '../reading-alignment/reading-alignment-book-consolidation.participant';
import { ReadingAlignmentModule } from '../reading-alignment/reading-alignment.module';
import { WebSerialsBookConsolidationParticipant } from '../web-serials/web-serials-book-consolidation.participant';
import { WebSerialsModule } from '../web-serials/web-serials.module';
import { BookConsolidationModule } from './book-consolidation.module';

type ForkMergeRule = 'repoint' | 'repoint-kept-wins' | 'repoint-pair' | 'repoint-kept-wins-stale' | 'follows-cover-slot';

/**
 * Fork tables sit outside the db/schema barrel, so upstream's registry test never sees them. A new
 * foreign key to books fails here until it has a rule and a participant moves its rows.
 * `follows-cover-slot` has no participant: adoptSlots copies the flag after commit, with the slot.
 */
const FORK_BOOK_MERGE_RULES: Record<string, ForkMergeRule> = {
  'audio_convert_jobs.book_id': 'repoint',
  'audio_convert_watch.book_id': 'repoint-kept-wins',
  'audiobook_alignment.audio_book_id': 'repoint-pair',
  'audiobook_alignment.text_book_id': 'repoint-pair',
  'audiobookshelf_book_state.book_id': 'repoint',
  'author_catalog_works.matched_audio_book_id': 'repoint',
  'author_catalog_works.matched_book_id': 'repoint',
  'author_catalog_works.matched_ebook_book_id': 'repoint',
  'author_catalog_works.possible_audio_book_id': 'repoint',
  'author_catalog_works.possible_ebook_book_id': 'repoint',
  'book_cover_placeholders.book_id': 'follows-cover-slot',
  'edition_sync_book_index.book_id': 'repoint-kept-wins-stale',
  'edition_sync_book_overrides.book_id': 'repoint-kept-wins',
  'monitored_match_overrides.book_id': 'repoint-kept-wins',
  'web_serial_imports.book_id': 'repoint',
  'web_serial_job_items.book_id': 'repoint',
};

const SQL_REFERENCE = /references\s+(?:"?public"?\.)?"?books"?(?![\w.])/gi;
const ALTER_TABLE_FK = /ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("(\w+)"\) REFERENCES "public"\."books"/g;
const CONSTRAINT_ENTRY_FK = /table:\s*(\w+),\s*name:\s*'[^']+',\s*definition:\s*'FOREIGN KEY \("(\w+)"\) REFERENCES "public"\."books"/g;
const DRIZZLE_REFERENCE = /\bbooks\.id\b/g;

function schemaSources(): Array<{ file: string; text: string }> {
  const modulesRoot = join(__dirname, '..');
  return readdirSync(modulesRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => /schema[^/\\]*\.ts$/.test(file) && !file.endsWith('.test.ts'))
    .map((file) => ({ file, text: readFileSync(join(modulesRoot, file), 'utf8') }));
}

function constantValue(text: string, name: string, file: string): string {
  const value = new RegExp(`const ${name}\\s*=\\s*'([^']+)'`).exec(text)?.[1];
  if (!value) throw new Error(`${file}: cannot resolve table constant ${name}`);
  return value;
}

function sqlKeys(file: string, text: string): string[] {
  const keys = [...text.matchAll(ALTER_TABLE_FK)].map((match) => `${match[1]}.${match[2]}`);
  keys.push(...[...text.matchAll(CONSTRAINT_ENTRY_FK)].map((match) => `${constantValue(text, match[1], file)}.${match[2]}`));
  const references = [...text.matchAll(SQL_REFERENCE)].length;
  if (keys.length !== references) throw new Error(`${file}: a foreign key to books uses a form this test cannot read`);
  return keys;
}

function drizzleKeys(file: string, text: string): string[] {
  return [...text.matchAll(DRIZZLE_REFERENCE)].map((match) => {
    const before = text.slice(0, match.index);
    const column = [...before.matchAll(/\b(?:integer|bigint)\('(\w+)'\)/g)].at(-1)?.[1];
    const table = [...before.matchAll(/pgTable\(\s*'(\w+)'/g)].at(-1)?.[1];
    if (!column || !table) throw new Error(`${file}: a books.id reference has no column or table this test can read`);
    return `${table}.${column}`;
  });
}

function forkBookForeignKeys(): string[] {
  const keys = schemaSources().flatMap(({ file, text }) => [...sqlKeys(file, text), ...drizzleKeys(file, text)]);
  return [...new Set(keys)].sort();
}

describe('fork book merge rules', () => {
  it('has a rule for exactly the fork foreign keys that reference books', () => {
    expect(forkBookForeignKeys()).toEqual(Object.keys(FORK_BOOK_MERGE_RULES).sort());
  });

  it.each([
    ['monitored', MonitoredModule, MonitoredBookConsolidationParticipant],
    ['audiobookshelf', AudiobookshelfModule, AudiobookshelfBookConsolidationParticipant],
    ['reading alignment', ReadingAlignmentModule, ReadingAlignmentBookConsolidationParticipant],
    ['edition sync', EditionSyncModule, EditionSyncBookConsolidationParticipant],
    ['web serials', WebSerialsModule, WebSerialsBookConsolidationParticipant],
    ['audio convert', AudioConvertModule, AudioConvertBookConsolidationParticipant],
  ])('wires the %s participant to the shared registry', (_name, module, participant) => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module)).toContain(participant);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, module)).toContain(BookConsolidationModule);
  });

  it('keeps the placeholder flag on a cover slot stored for adoption after commit', () => {
    const stored = { medium: 'ebook', updatedAt: '2026-01-01T00:00:00.000Z', dormantSince: null, placeholder: true };
    expect(reviveCoverSlots([stored] as never)[0]).toMatchObject({ medium: 'ebook', placeholder: true });
  });
});
