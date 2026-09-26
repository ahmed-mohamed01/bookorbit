import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditionLinkRepository } from './edition-link.repository';
import { bookEditionLinks } from './schema/edition-link.schema';

function makeChain(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  const methods = ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'values', 'set', 'onConflictDoNothing', 'returning'];
  for (const method of methods) chain[method] = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

// Walks a drizzle SQL tree and collects every referenced column name, so a `where` clause can be
// asserted on the columns it actually filters rather than on its object identity.
function referencedColumns(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  const node = value as Record<string, unknown>;
  if (typeof node.name === 'string' && 'table' in node) found.add(node.name);
  if (Array.isArray(node.queryChunks)) for (const chunk of node.queryChunks) referencedColumns(chunk, found);
  return found;
}

// Collects the bound parameter values of a drizzle SQL tree, so a clause can be asserted on the ids
// it actually binds rather than only on the columns it names.
function boundValues(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) boundValues(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const node = value as Record<string, unknown>;
  if ('encoder' in node && 'value' in node) found.push(node.value);
  if (Array.isArray(node.queryChunks)) for (const chunk of node.queryChunks) boundValues(chunk, found);
  return found;
}

// Concatenates the literal SQL fragments of a drizzle SQL tree, so a hand-written clause can be
// asserted on its text.
function rawSqlText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.value)) return node.value.filter((part) => typeof part === 'string').join('');
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map((chunk) => rawSqlText(chunk)).join('');
  return '';
}

describe('EditionLinkRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getBookModality', () => {
    it.each([
      [[{ format: 'epub' }], 'text'],
      [[{ format: 'M4B' }], 'audio'],
      [[{ format: 'kepub' }, { format: 'mp3' }], 'both'],
      [[{ format: 'pdf' }, { format: null }], 'none'],
    ] as const)('detects content formats as %s', async (rows, expected) => {
      const chain = makeChain(rows);
      const repo = new EditionLinkRepository({ select: vi.fn(() => chain) } as never);

      await expect(repo.getBookModality(42)).resolves.toBe(expected);
      expect(chain.where).toHaveBeenCalledOnce();
    });
  });

  it('ranks plausible opposite-modality candidates and filters unrelated rows', async () => {
    const sourceChain = makeChain([{ title: 'Dune' }]);
    const sourceAuthorsChain = makeChain([{ name: 'Frank Herbert' }]);
    const candidatesChain = makeChain([
      { bookId: 2, title: 'Dune', authorNames: ['Frank Herbert'], coverUpdatedAt: new Date('2026-03-01T00:00:00.000Z') },
      { bookId: 3, title: 'Cooking for Beginners', authorNames: ['Ada Baker'], coverUpdatedAt: null },
    ]);
    const db = {
      select: vi.fn().mockReturnValueOnce(sourceChain).mockReturnValueOnce(sourceAuthorsChain).mockReturnValueOnce(candidatesChain),
    };
    const repo = new EditionLinkRepository(db as never);

    await expect(
      repo.findCounterpartCandidates({
        bookId: 1,
        modality: 'text',
        accessibleLibraryIds: [10, 11],
      }),
    ).resolves.toEqual([{ bookId: 2, title: 'Dune', authorName: 'Frank Herbert', coverVersion: '2026-03-01T00:00:00.000Z', score: 100 }]);
    expect(candidatesChain.where).toHaveBeenCalledOnce();
    expect(candidatesChain.limit).toHaveBeenCalledWith(100);
  });

  it('filters explicit candidate searches by title or author text', async () => {
    const sourceChain = makeChain([{ title: 'Dune' }]);
    const sourceAuthorsChain = makeChain([{ name: 'Frank Herbert' }]);
    const candidatesChain = makeChain([
      { bookId: 2, title: 'Dune', authorNames: ['Frank Herbert'] },
      { bookId: 3, title: 'The Left Hand of Darkness', authorNames: ['Ursula K. Le Guin'] },
    ]);
    const db = {
      select: vi.fn().mockReturnValueOnce(sourceChain).mockReturnValueOnce(sourceAuthorsChain).mockReturnValueOnce(candidatesChain),
    };
    const repo = new EditionLinkRepository(db as never);

    const results = await repo.findCounterpartCandidates({
      bookId: 1,
      modality: 'text',
      accessibleLibraryIds: [10],
      query: 'Le Guin',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      bookId: 3,
      title: 'The Left Hand of Darkness',
      authorName: 'Ursula K. Le Guin',
    });
  });

  describe('findBookSummary', () => {
    it('resolves the counterpart title and first author in one joined query', async () => {
      const chain = makeChain([
        { id: 20, title: 'Dune', authorNames: ['Frank Herbert', 'Co-Author'], coverUpdatedAt: new Date('2026-03-01T00:00:00.000Z') },
      ]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(20)).resolves.toEqual({
        id: 20,
        title: 'Dune',
        authorName: 'Frank Herbert',
        coverVersion: '2026-03-01T00:00:00.000Z',
      });
      expect(db.select).toHaveBeenCalledOnce();
      expect(chain.where).toHaveBeenCalledOnce();
    });

    it('returns null when the book has no metadata row', async () => {
      const chain = makeChain([]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(999)).resolves.toBeNull();
    });

    it('falls back to a null author when the book has no authors', async () => {
      const chain = makeChain([{ id: 20, title: 'Dune', authorNames: [], coverUpdatedAt: null }]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummary(20)).resolves.toEqual({ id: 20, title: 'Dune', authorName: null, coverVersion: null });
    });
  });

  describe('findBookSummaries', () => {
    it('resolves every member in one query, keyed by book id', async () => {
      const chain = makeChain([
        { id: 10, title: 'Dune', authorNames: ['Frank Herbert'], coverUpdatedAt: new Date('2026-03-01T00:00:00.000Z') },
        { id: 30, title: 'Dune (read-along)', authorNames: [], coverUpdatedAt: null },
      ]);
      const db = { select: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      const summaries = await repo.findBookSummaries([10, 20, 30]);

      expect(db.select).toHaveBeenCalledOnce();
      expect(summaries.get(10)).toEqual({ id: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: '2026-03-01T00:00:00.000Z' });
      expect(summaries.get(30)).toEqual({ id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null });
      expect(summaries.has(20)).toBe(false);
      expect(boundValues(chain.where.mock.calls[0]![0]).flat()).toEqual([10, 20, 30]);
    });

    it('skips the query entirely for an empty id list', async () => {
      const db = { select: vi.fn() };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findBookSummaries([])).resolves.toEqual(new Map());
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  it('inserts a correctly oriented link and returns it', async () => {
    const row = {
      id: 5,
      textBookId: 10,
      audioBookId: 20,
      createdBy: 7,
      createdAt: new Date(),
    };
    const chain = makeChain([row]);
    const db = { insert: vi.fn(() => chain) };
    const repo = new EditionLinkRepository(db as never);

    await expect(repo.insertLink(10, 20, 7)).resolves.toEqual(row);
    expect(db.insert).toHaveBeenCalledWith(bookEditionLinks);
    expect(chain.values).toHaveBeenCalledWith({ textBookId: 10, audioBookId: 20, createdBy: 7 });
    expect(chain.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('deletes and returns the single link addressed by its id', async () => {
    const row = {
      id: 5,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 7,
      createdAt: new Date(),
    };
    const chain = makeChain([row]);
    const db = { delete: vi.fn(() => chain) };
    const repo = new EditionLinkRepository(db as never);

    await expect(repo.deleteLink(5)).resolves.toEqual(row);
    expect(db.delete).toHaveBeenCalledWith(bookEditionLinks);
    expect(chain.where).toHaveBeenCalledOnce();
  });

  // An OR across the member columns would delete every link a book belongs to and return only the
  // first of them, so the delete must name the primary key and nothing else.
  it('never matches a member column when deleting a link', async () => {
    const chain = makeChain([]);
    const repo = new EditionLinkRepository({ delete: vi.fn(() => chain) } as never);

    await repo.deleteLink(5);

    const clause = chain.where.mock.calls[0]![0];
    const columns = referencedColumns(clause);
    expect(columns).toContain('id');
    expect(columns).not.toContain('text_book_id');
    expect(columns).not.toContain('audio_book_id');
    expect(columns).not.toContain('read_along_book_id');
    expect(boundValues(clause).flat()).toEqual([5]);
  });

  it('matches all three members in findLinkForBook', async () => {
    const chain = makeChain([]);
    const repo = new EditionLinkRepository({ select: vi.fn(() => chain) } as never);

    await repo.findLinkForBook(30);

    const columns = referencedColumns(chain.where.mock.calls[0]![0]);
    expect(columns).toContain('text_book_id');
    expect(columns).toContain('audio_book_id');
    expect(columns).toContain('read_along_book_id');
  });

  describe('setReadAlongBook', () => {
    it('stores the generated read-along book on the link and returns the updated row', async () => {
      const row = { id: 5, textBookId: 10, audioBookId: 20, readAlongBookId: 30, createdBy: 7, createdAt: new Date() };
      const chain = makeChain([row]);
      const db = { update: vi.fn(() => chain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.setReadAlongBook(5, 30)).resolves.toEqual(row);
      expect(db.update).toHaveBeenCalledWith(bookEditionLinks);
      expect(chain.set).toHaveBeenCalledWith({ readAlongBookId: 30 });
      expect(referencedColumns(chain.where.mock.calls[0]![0])).toContain('id');
    });

    it('clears the read-along member when given null', async () => {
      const chain = makeChain([]);
      const repo = new EditionLinkRepository({ update: vi.fn(() => chain) } as never);

      await expect(repo.setReadAlongBook(5, null)).resolves.toBeUndefined();
      expect(chain.set).toHaveBeenCalledWith({ readAlongBookId: null });
      // A detach has no member to exclude, so the predicate binds the link id alone.
      expect(boundValues(chain.where.mock.calls[0]![0]).flat()).toEqual([5]);
    });

    // A row-scoped `ne(text) AND ne(audio)` under `eq(id, linkId)` only rejects a book that is a
    // member of THIS link. The partial unique index covers read-along-vs-read-along but says nothing
    // about a book that is already another link's text or audio member, so the exclusion has to look
    // at the whole table.
    it('refuses a book that is any link own text or audio member', async () => {
      const chain = makeChain([]);
      const repo = new EditionLinkRepository({ update: vi.fn(() => chain) } as never);

      await expect(repo.setReadAlongBook(5, 10)).resolves.toBeUndefined();
      const clause = chain.where.mock.calls[0]![0];
      const sqlText = rawSqlText(clause).replace(/\s+/g, ' ');
      expect(sqlText).toContain('NOT EXISTS');
      expect(sqlText).toContain('FROM book_edition_links member_link');
      expect(sqlText).toContain('member_link.text_book_id');
      expect(sqlText).toContain('member_link.audio_book_id');
      // The exclusion must not be a row-scoped ne() on this link's own member columns.
      const columns = referencedColumns(clause);
      expect(columns).toContain('id');
      expect(columns).not.toContain('text_book_id');
      expect(columns).not.toContain('audio_book_id');
    });
  });

  it('excludes books that are already a read-along member from candidates', async () => {
    const sourceChain = makeChain([{ title: 'Dune' }]);
    const sourceAuthorsChain = makeChain([]);
    const candidatesChain = makeChain([]);
    const db = {
      select: vi.fn().mockReturnValueOnce(sourceChain).mockReturnValueOnce(sourceAuthorsChain).mockReturnValueOnce(candidatesChain),
    };
    const repo = new EditionLinkRepository(db as never);

    await repo.findCounterpartCandidates({ bookId: 1, modality: 'text', accessibleLibraryIds: [10] });

    expect(rawSqlText(candidatesChain.where.mock.calls[0]![0])).toContain('existing_link.read_along_book_id');
  });

  describe('findMemberProgress', () => {
    const textProgress = { bookId: 10, percentage: 40, lastReadAt: new Date('2026-09-01T00:00:00.000Z'), narrationPercentage: null };
    const readAlongProgress = { bookId: 30, percentage: 55, lastReadAt: new Date('2026-09-02T00:00:00.000Z'), narrationPercentage: 61 };
    const audioProgress = { percentage: 12, updatedAt: new Date('2026-09-03T00:00:00.000Z') };

    it('resolves progress for all three members in two queries', async () => {
      const fileChain = makeChain([textProgress, readAlongProgress]);
      const audioChain = makeChain([audioProgress]);
      const db = { select: vi.fn().mockReturnValueOnce(fileChain).mockReturnValueOnce(audioChain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findMemberProgress(7, { textBookId: 10, audioBookId: 20, readAlongBookId: 30 })).resolves.toEqual({
        text: { percentage: 40, updatedAt: textProgress.lastReadAt },
        audio: { percentage: 12, updatedAt: audioProgress.updatedAt },
        readAlong: { percentage: 55, updatedAt: readAlongProgress.lastReadAt },
        readAlongNarrationPercentage: 61,
      });
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('returns nulls for members without a progress row', async () => {
      const fileChain = makeChain([]);
      const audioChain = makeChain([]);
      const db = { select: vi.fn().mockReturnValueOnce(fileChain).mockReturnValueOnce(audioChain) };
      const repo = new EditionLinkRepository(db as never);

      await expect(repo.findMemberProgress(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null })).resolves.toEqual({
        text: null,
        audio: null,
        readAlong: null,
        readAlongNarrationPercentage: null,
      });
    });

    it('does not look up a read-along row when the link has no read-along member', async () => {
      const fileChain = makeChain([textProgress]);
      const audioChain = makeChain([audioProgress]);
      const db = { select: vi.fn().mockReturnValueOnce(fileChain).mockReturnValueOnce(audioChain) };
      const repo = new EditionLinkRepository(db as never);

      const result = await repo.findMemberProgress(7, { textBookId: 10, audioBookId: 20, readAlongBookId: null });

      expect(result.readAlong).toBeNull();
      expect(result.readAlongNarrationPercentage).toBeNull();
      expect(referencedColumns(fileChain.where.mock.calls[0]![0])).toContain('id');
      expect(boundValues(fileChain.where.mock.calls[0]![0]).flat()).toEqual([10]);
    });

    it('binds both the text and the read-along id when a read-along member exists', async () => {
      const fileChain = makeChain([textProgress, readAlongProgress]);
      const audioChain = makeChain([audioProgress]);
      const db = { select: vi.fn().mockReturnValueOnce(fileChain).mockReturnValueOnce(audioChain) };
      const repo = new EditionLinkRepository(db as never);

      await repo.findMemberProgress(7, { textBookId: 10, audioBookId: 20, readAlongBookId: 30 });

      expect(boundValues(fileChain.where.mock.calls[0]![0]).flat()).toEqual([10, 30]);
    });
  });
});
