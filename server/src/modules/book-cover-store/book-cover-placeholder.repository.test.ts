import { describe, expect, it, vi } from 'vitest';
import { bookCovers, bookMetadata, books } from '../../db/schema';
import {
  BookCoverStoreRepository,
  coverSourceForSlots,
  didKoboCoverChange,
  resolveKoboCoverMedium,
  type BookCoverSlotState,
} from './book-cover-store.repository';
import { bookCoverPlaceholders } from './schema/book-cover-placeholder.schema';

const media = { hasEbook: true, hasAudio: true };
function slot(medium: 'ebook' | 'audio', source = 'extracted', placeholder = false): BookCoverSlotState {
  return { bookId: 7, medium, source, placeholder, origin: 'embedded', width: 100, height: 100, updatedAt: new Date(0), dormantSince: null };
}

function harness(rows: BookCoverSlotState[]) {
  let states = rows.map((row) => ({ ...row }));
  const writes: Array<{ table: unknown; values: unknown }> = [];
  const deleted: unknown[] = [];
  const originalStamp = new Date(0);
  const tx = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn((table: unknown) => {
          const result =
            table === bookCovers
              ? states.map((row) => ({ ...row }))
              : table === books
                ? [{ libraryId: 3 }]
                : [{ updatedAt: originalStamp, coverUpdatedAt: originalStamp }];
          return { where: () => Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) }) };
        }),
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return {
          onConflictDoNothing: () => {
            states = states.map((row) => ({ ...row, placeholder: true }));
            return Promise.resolve();
          },
          onConflictDoUpdate: () => {
            if (table === bookCovers) states = states.map((row) => ({ ...row, ...values }) as BookCoverSlotState);
            return Promise.resolve();
          },
        };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: () => {
        deleted.push(table);
        if (table === bookCoverPlaceholders) states = states.map((row) => ({ ...row, placeholder: false }));
        else states = [];
        return Promise.resolve();
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: unknown) => {
        writes.push({ table, values });
        return { where: () => Promise.resolve() };
      },
    })),
  };
  const db = { transaction: (run: (executor: typeof tx) => unknown) => run(tx) };
  return { repository: new BookCoverStoreRepository(db as never), writes, deleted, originalStamp };
}

describe('placeholder cover summaries and mutations', () => {
  it('counts only served rows in summaries and Kobo selection', () => {
    const hidden = slot('ebook', 'custom', true);
    expect(coverSourceForSlots([hidden, slot('audio')], media)).toBe('extracted');
    expect(coverSourceForSlots([hidden], media)).toBeNull();
    expect(resolveKoboCoverMedium([hidden, slot('audio')], media)).toBe('audio');
    expect(didKoboCoverChange([slot('ebook')], [hidden], media, 'ebook', false)).toBe(true);
    expect(didKoboCoverChange([slot('ebook'), slot('audio')], [slot('ebook'), slot('audio', 'custom', true)], media, 'audio', false)).toBe(false);
  });

  it.each([true, false])('clears the switch only for served byte writes: %s', async (servedBytesChanged) => {
    const { repository, deleted, writes } = harness([slot('ebook', 'custom', true)]);
    await repository.applySlotMutation(
      7,
      'ebook',
      media,
      { kind: 'upsert', row: { source: 'extracted' } },
      { bumpBook: true, servedBytesChanged, updatedAt: new Date(100) },
    );
    expect(deleted.includes(bookCoverPlaceholders)).toBe(servedBytesChanged);
    expect(writes.find((write) => write.table === bookMetadata)?.values).toMatchObject({ coverSource: servedBytesChanged ? 'extracted' : null });
  });

  it('keeps the switch on an adopted slot instead of clearing it', async () => {
    const { repository, deleted, writes } = harness([]);
    await repository.applySlotMutation(
      7,
      'ebook',
      media,
      { kind: 'upsert', row: { source: 'custom', origin: 'embedded' } },
      { bumpBook: true, servedBytesChanged: true, updatedAt: new Date(100), placeholder: true },
    );
    expect(writes.some((write) => write.table === bookCoverPlaceholders)).toBe(true);
    expect(deleted.includes(bookCoverPlaceholders)).toBe(false);
  });

  it('cleans up the switch on slot deletion', async () => {
    const { repository, deleted } = harness([slot('ebook', 'custom', true)]);
    await repository.applySlotMutation(7, 'ebook', media, { kind: 'delete' }, { bumpBook: true, servedBytesChanged: false, updatedAt: new Date() });
    expect(deleted).toEqual([bookCovers, bookCoverPlaceholders]);
  });

  it('updates summary and Kobo stamp together when toggled', async () => {
    const { repository, writes } = harness([slot('ebook', 'custom')]);
    const updatedAt = new Date(100);
    await expect(repository.setPlaceholder(7, 'ebook', media, true, { updatedAt })).resolves.toMatchObject({ libraryId: 3 });
    expect(writes.find((write) => write.table === bookMetadata)?.values).toEqual({
      bookId: 7,
      coverSource: null,
      coverUpdatedAt: updatedAt,
      updatedAt,
    });
    expect(writes.find((write) => write.table === books)?.values).toEqual({ updatedAt });
  });
});
