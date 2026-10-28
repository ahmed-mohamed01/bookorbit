import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { books } from '../../db/schema';
import { DEFAULT_EDITION_LINK_SETTINGS } from './edition-link-settings.service';
import { pickCanonical, WorkScopeService, type WorkMember } from './work-scope.service';

const at = new Date('2026-01-01T00:00:00.000Z');
const member = (bookId: number, role: WorkMember['role'], isPrimary = true, createdAt = at): WorkMember => ({ bookId, role, isPrimary, createdAt });

function makeService(rows: unknown[], settings = DEFAULT_EDITION_LINK_SETTINGS) {
  const chain = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn().mockResolvedValue(rows) };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  const db = { select: vi.fn().mockReturnValue(chain) };
  const settingsService = { get: vi.fn().mockResolvedValue(settings) };
  return { service: new WorkScopeService(db as never, settingsService as never), db, settingsService };
}

describe('pickCanonical', () => {
  it('prefers the primary audiobook, then the primary ebook, then the read-along', () => {
    expect(pickCanonical([member(10, 'text'), member(20, 'audio'), member(30, 'readAlong')])).toBe(20);
    expect(pickCanonical([member(10, 'text'), member(30, 'readAlong')])).toBe(10);
    expect(pickCanonical([member(30, 'readAlong')])).toBe(30);
  });

  it('hands the role to a visible duplicate when the primary is hidden', () => {
    expect(pickCanonical([member(10, 'text'), member(21, 'audio', false)])).toBe(21);
  });
});

describe('WorkScopeService', () => {
  const rows = [
    { linkId: 4, bookId: 10, role: 'text', isPrimary: true, createdAt: at },
    { linkId: 4, bookId: 20, role: 'audio', isPrimary: true, createdAt: at },
    { linkId: 4, bookId: 11, role: 'text', isPrimary: false, createdAt: at },
  ];

  it('resolves every requested book of a work in one query and caches it', async () => {
    const { service, db } = makeService(rows);

    const works = await service.resolveMany(7, [10, 11]);
    expect(works.get(10)?.canonicalBookId).toBe(20);
    expect(works.get(11)?.members.map((entry) => entry.bookId)).toEqual([10, 20, 11]);
    await service.resolve(7, 10);
    expect(db.select).toHaveBeenCalledTimes(2);

    service.invalidate();
    await service.resolve(7, 10);
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it('gives the shared reading scope only while sharing is on', async () => {
    await expect(makeService(rows).service.resolveScope(7, 11)).resolves.toEqual({ canonicalBookId: 20, mirrorBookIds: [10, 11] });
    await expect(makeService(rows, { ...DEFAULT_EDITION_LINK_SETTINGS, shareReadingState: false }).service.resolveScope(7, 11)).resolves.toBeNull();
    await expect(makeService(rows, { ...DEFAULT_EDITION_LINK_SETTINGS, enabled: false }).service.resolveScope(7, 11)).resolves.toBeNull();
  });

  it('reads a work with a single visible member as no work', async () => {
    const { service } = makeService([rows[0]]);

    await expect(service.resolve(7, 10)).resolves.toBeNull();
    await expect(service.canonicalBookId(7, 10)).resolves.toBe(10);
  });

  it('keeps non-primary ebook copies off the Kobo shelf while works are on', async () => {
    const filter = await makeService([]).service.shelfFilter(7, books.id);
    const rendered = new PgDialect().sqlToQuery(filter!);

    expect(rendered.sql).toContain("shelf_member.role = 'text' AND NOT shelf_member.is_primary");
    await expect(makeService([], { ...DEFAULT_EDITION_LINK_SETTINGS, enabled: false }).service.shelfFilter(7, books.id)).resolves.toBeUndefined();
  });
});
