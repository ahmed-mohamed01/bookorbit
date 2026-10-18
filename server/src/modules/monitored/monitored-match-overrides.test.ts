import { describe, expect, it } from 'vitest';

import { matchIdentityKeys, resolveWorkMatchOverrides } from './monitored-match-overrides';
import type { MonitoredMatchOverrideRow } from './schema/monitored.schema';

function row(patch: Partial<MonitoredMatchOverrideRow>): MonitoredMatchOverrideRow {
  return {
    monitorAuthorId: 'monitor-1',
    format: 'ebook',
    identityKey: 'hardcover:1',
    bookId: 10,
    decision: 'link',
    workId: 'w-1',
    decidedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...patch,
  };
}

describe('matchIdentityKeys', () => {
  it('files an answer under every provider id the work carries', () => {
    expect(matchIdentityKeys({ title: 'Inhibitor Phase', providerWorkIds: { hardcover: '1', audible: 'B0' } })).toEqual([
      'audible:B0',
      'hardcover:1',
    ]);
  });

  it('falls back to the title only for a work no provider identifies', () => {
    const [key] = matchIdentityKeys({ title: 'Inhibitor Phase', providerWorkIds: {} });

    expect(key).toMatch(/^title:[0-9a-f]{64}$/);
    expect(matchIdentityKeys({ title: 'inhibitor  phase', providerWorkIds: {} })).toEqual([key]);
  });
});

describe('resolveWorkMatchOverrides', () => {
  const work = { title: 'Inhibitor Phase', providerWorkIds: { hardcover: '1', goodreads: '2' } };

  it('reads answers filed under any of the work key and ignores other works', () => {
    const result = resolveWorkMatchOverrides(work, [
      row({ identityKey: 'goodreads:2', bookId: 10 }),
      row({ identityKey: 'hardcover:9', bookId: 99, decision: 'reject' }),
    ]);

    expect(result.ebook.linkedBookId).toBe(10);
    expect(result.ebook.rejected.size).toBe(0);
    expect(result.audiobook.linkedBookId).toBeNull();
  });

  it('lets the newest answer about a book win', () => {
    const result = resolveWorkMatchOverrides(work, [
      row({ bookId: 10, decision: 'reject', decidedAt: new Date('2026-10-02T00:00:00.000Z') }),
      row({ identityKey: 'goodreads:2', bookId: 10, decision: 'link', decidedAt: new Date('2026-10-01T00:00:00.000Z') }),
    ]);

    expect(result.ebook.linkedBookId).toBeNull();
    expect([...result.ebook.rejected]).toEqual([10]);
  });

  it('keeps each format apart', () => {
    const result = resolveWorkMatchOverrides(work, [row({ format: 'audiobook', bookId: 20, decision: 'reject' })]);

    expect([...result.audiobook.rejected]).toEqual([20]);
    expect(result.ebook.rejected.size).toBe(0);
  });
});
