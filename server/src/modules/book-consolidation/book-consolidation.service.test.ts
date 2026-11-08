import type { BookConsolidationParticipants, ConsolidationTx } from './book-consolidation-participants';
import type { BookConsolidationRepository } from './book-consolidation.repository';
import { BookConsolidationService } from './book-consolidation.service';

const tx = { marker: 'tx' } as unknown as ConsolidationTx;
const KEPT = 1;
const SOURCE = 2;

function makeRepository(calls: string[]): BookConsolidationRepository {
  const answers: Record<string, unknown> = {
    lockBooks: [
      { id: KEPT, libraryId: 5, libraryFolderId: 6, folderPath: '/kept', addedAt: null },
      { id: SOURCE, libraryId: 5, libraryFolderId: 6, folderPath: '/source', addedAt: null },
    ],
    sourceReaderPage: [],
    reconcileRatings: [],
    moveKoboEntitlements: [],
    hasKoboEntitlements: false,
    readSnapshot: {},
  };
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as BookConsolidationRepository, {
    get(_target, property: string) {
      let method = methods.get(property);
      if (!method) {
        method = vi.fn((...args: unknown[]) => {
          calls.push(property);
          if (property === 'loadFacts') {
            return Promise.resolve({
              bookId: args[1],
              metadata: null,
              lockedFields: new Set(),
              authors: [],
              narrators: [],
              series: [],
              hasAudio: false,
            });
          }
          return Promise.resolve(answers[property]);
        });
        methods.set(property, method);
      }
      return method;
    },
  });
}

const input = { targetBookId: KEPT, sourceBookId: SOURCE, destination: null, fieldSources: new Map(), mergedByUserId: 9 };

describe('BookConsolidationService.consolidate participants', () => {
  it('moves participant rows on the same transaction after every upstream move and before the delete', async () => {
    const calls: string[] = [];
    const moveAll = vi.fn<BookConsolidationParticipants['moveAll']>(() => {
      calls.push('moveAll');
      return Promise.resolve();
    });
    const service = new BookConsolidationService(makeRepository(calls), { moveAll } as unknown as BookConsolidationParticipants);

    await service.consolidate(tx, input);

    expect(moveAll).toHaveBeenCalledExactlyOnceWith(tx, KEPT, SOURCE);
    expect(calls.indexOf('moveAll')).toBe(calls.indexOf('deleteBook') - 1);
    expect(calls.indexOf('fillBookLevelRows')).toBeLessThan(calls.indexOf('moveAll'));
    expect(calls.indexOf('recordAlias')).toBeLessThan(calls.indexOf('moveAll'));
  });

  it('leaves the book undeleted when a participant fails', async () => {
    const calls: string[] = [];
    const failure = new Error('boom');
    const service = new BookConsolidationService(makeRepository(calls), {
      moveAll: () => Promise.reject(failure),
    } as unknown as BookConsolidationParticipants);

    await expect(service.consolidate(tx, input)).rejects.toBe(failure);
    expect(calls).not.toContain('deleteBook');
  });

  it('works with no registry', async () => {
    const calls: string[] = [];
    await new BookConsolidationService(makeRepository(calls)).consolidate(tx, input);
    expect(calls).toContain('deleteBook');
  });
});

describe('BookConsolidationService.absorbDuplicate participants', () => {
  it('moves participant rows and changes nothing else when no reader has data on the duplicate', async () => {
    const calls: string[] = [];
    const moveAll = vi.fn<BookConsolidationParticipants['moveAll']>(() => Promise.resolve());
    const service = new BookConsolidationService(makeRepository(calls), { moveAll } as unknown as BookConsolidationParticipants);

    const absorbed = await service.absorbDuplicate(tx, { targetBookId: KEPT, duplicateBookId: SOURCE, incomingFiles: [], mergedByUserId: 9 });

    expect(absorbed).toBe(false);
    expect(moveAll).toHaveBeenCalledWith(tx, KEPT, SOURCE);
    expect(calls).toEqual(['lockBooks', 'carriesUserData']);
  });
});
