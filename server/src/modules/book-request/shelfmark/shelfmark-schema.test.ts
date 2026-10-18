import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { BOOK_REQUEST_DOWNLOAD_SOURCES, BOOK_REQUEST_DOWNLOAD_STATUSES, DOWNLOAD_CLIENT_TYPES } from '@bookorbit/types';

import { bookRequestDownloads, downloadClients } from '../../../db/schema';

const dialect = new PgDialect();

function toSql(value: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return dialect.sqlToQuery(value).sql;
}

function quotedLiterals(sql: string): string[] {
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

// Fork copy of db/schema/download-clients.schema.test.ts, which vitest excludes: the shared constants carry Shelfmark,
// while the upstream CHECKs do not, because the Shelfmark schema bootstrap adds it at boot.
const withShelfmark = (values: string[]) => [...values, 'shelfmark'].sort();

describe('download client schema SQL matches the shared constants', () => {
  const clientConfig = getTableConfig(downloadClients);
  const downloadConfig = getTableConfig(bookRequestDownloads);

  it('accepts the declared adapter types once the bootstrap adds Shelfmark', () => {
    const check = clientConfig.checks.find((c) => c.name === 'download_clients_adapter_type_chk');
    expect(check).toBeDefined();
    expect(withShelfmark(quotedLiterals(toSql(check!.value)))).toEqual([...DOWNLOAD_CLIENT_TYPES].sort());
  });

  it('accepts exactly the download statuses declared in @bookorbit/types', () => {
    const check = downloadConfig.checks.find((c) => c.name === 'book_request_downloads_status_chk');
    expect(check).toBeDefined();
    expect(quotedLiterals(toSql(check!.value)).sort()).toEqual([...BOOK_REQUEST_DOWNLOAD_STATUSES].sort());
  });

  it('accepts the declared grab sources once the bootstrap adds Shelfmark', () => {
    const check = downloadConfig.checks.find((c) => c.name === 'book_request_downloads_source_chk');
    expect(check).toBeDefined();
    expect(withShelfmark(quotedLiterals(toSql(check!.value)))).toEqual([...BOOK_REQUEST_DOWNLOAD_SOURCES].sort());
  });

  it('scopes the one-live-attempt-per-hash index to every status whose bytes are still needed', () => {
    const index = downloadConfig.indexes.find((i) => i.config.name === 'book_request_downloads_active_hash_uidx');
    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    expect(quotedLiterals(toSql(index!.config.where!)).sort()).toEqual(['completed', 'downloading', 'importing', 'needs_review', 'queued']);
  });
});
