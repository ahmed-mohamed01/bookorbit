import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';

import type { WorkVariantRole } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { books } from '../../db/schema';
import type { KoboShelfFilterSource } from '../kobo/kobo-shelf-filter-source';
import type { ReadingStateScope, ReadingStateScopeSource } from '../user-book-status/reading-state-scope-source';
import { EditionLinkSettingsService, sharesReadingState } from './edition-link-settings.service';
import { bookEditionLinkMembers } from './schema/work.schema';

type Db = NodePgDatabase<typeof schema>;

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 5000;
const ROLE_ORDER: readonly WorkVariantRole[] = ['audio', 'text', 'readAlong'];

export interface WorkMember {
  bookId: number;
  role: WorkVariantRole;
  isPrimary: boolean;
  createdAt: Date;
}

export interface ResolvedWork {
  linkId: number;
  canonicalBookId: number;
  members: WorkMember[];
}

/**
 * Attempts and status live on the primary audiobook, else the primary ebook, else the read-along.
 * Only the members the reader can open count, so a hidden primary hands the role to a visible copy.
 */
export function pickCanonical(members: readonly WorkMember[]): number | null {
  for (const role of ROLE_ORDER) {
    const ofRole = members.filter((member) => member.role === role);
    if (ofRole.length === 0) continue;
    const ranked = [...ofRole].sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) || left.createdAt.getTime() - right.createdAt.getTime() || left.bookId - right.bookId,
    );
    return ranked[0]!.bookId;
  }
  return null;
}

// The read side of works: which books share a reading state for a reader, cached briefly because it
// sits on every progress and status write. Any link write calls invalidate().
@Injectable()
export class WorkScopeService implements ReadingStateScopeSource, KoboShelfFilterSource {
  private readonly cache = new Map<string, { value: ResolvedWork | null; at: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: EditionLinkSettingsService,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async resolve(userId: number, bookId: number): Promise<ResolvedWork | null> {
    return (await this.resolveMany(userId, [bookId])).get(bookId) ?? null;
  }

  async resolveMany(userId: number, bookIds: readonly number[]): Promise<Map<number, ResolvedWork>> {
    const result = new Map<number, ResolvedWork>();
    const missing: number[] = [];
    const now = Date.now();
    for (const bookId of new Set(bookIds)) {
      const cached = this.cache.get(this.key(userId, bookId));
      if (cached && now - cached.at < CACHE_TTL_MS) {
        if (cached.value) result.set(bookId, cached.value);
      } else {
        missing.push(bookId);
      }
    }
    if (missing.length === 0) return result;

    const works = await this.loadWorks(userId, missing);
    for (const bookId of missing) {
      const work = works.get(bookId) ?? null;
      this.remember(this.key(userId, bookId), work);
      if (work) result.set(bookId, work);
    }
    return result;
  }

  async canonicalBookId(userId: number, bookId: number): Promise<number> {
    return (await this.resolveScope(userId, bookId))?.canonicalBookId ?? bookId;
  }

  async resolveScope(userId: number, bookId: number): Promise<ReadingStateScope | null> {
    if (!sharesReadingState(await this.settings.get(userId))) return null;
    const work = await this.resolve(userId, bookId);
    if (!work) return null;
    return {
      canonicalBookId: work.canonicalBookId,
      mirrorBookIds: work.members.map((member) => member.bookId).filter((id) => id !== work.canonicalBookId),
    };
  }

  async shelfFilter(userId: number, bookId: PgColumn): Promise<SQL | undefined> {
    if (!(await this.settings.get(userId)).enabled) return undefined;
    return sql`NOT EXISTS (
      SELECT 1 FROM ${bookEditionLinkMembers} shelf_member
      WHERE shelf_member.book_id = ${bookId} AND shelf_member.role = 'text' AND NOT shelf_member.is_primary
    )`;
  }

  private async loadWorks(userId: number, bookIds: number[]): Promise<Map<number, ResolvedWork>> {
    const linkIds = this.db
      .select({ linkId: bookEditionLinkMembers.linkId })
      .from(bookEditionLinkMembers)
      .where(inArray(bookEditionLinkMembers.bookId, bookIds));
    const rows = await this.db
      .select({
        linkId: bookEditionLinkMembers.linkId,
        bookId: bookEditionLinkMembers.bookId,
        role: bookEditionLinkMembers.role,
        isPrimary: bookEditionLinkMembers.isPrimary,
        createdAt: bookEditionLinkMembers.createdAt,
      })
      .from(bookEditionLinkMembers)
      .innerJoin(books, eq(books.id, bookEditionLinkMembers.bookId))
      .where(
        and(
          inArray(bookEditionLinkMembers.linkId, linkIds),
          sql`(
            EXISTS (SELECT 1 FROM ${schema.users} scope_user WHERE scope_user.id = ${userId} AND scope_user.is_superuser)
            OR EXISTS (
              SELECT 1 FROM ${schema.userLibraryAccess} scope_access
              WHERE scope_access.user_id = ${userId} AND scope_access.library_id = ${books.libraryId}
            )
          )`,
        ),
      )
      .orderBy(asc(bookEditionLinkMembers.linkId), asc(bookEditionLinkMembers.createdAt), asc(bookEditionLinkMembers.id));

    const membersByLink = new Map<number, WorkMember[]>();
    for (const row of rows) {
      const members = membersByLink.get(row.linkId) ?? [];
      members.push({ bookId: row.bookId, role: row.role, isPrimary: row.isPrimary, createdAt: row.createdAt });
      membersByLink.set(row.linkId, members);
    }

    const works = new Map<number, ResolvedWork>();
    for (const [linkId, members] of membersByLink) {
      if (members.length < 2) continue;
      const canonicalBookId = pickCanonical(members);
      if (canonicalBookId === null) continue;
      const work = { linkId, canonicalBookId, members };
      for (const member of members) works.set(member.bookId, work);
    }
    return works;
  }

  private key(userId: number, bookId: number): string {
    return `${userId}:${bookId}`;
  }

  private remember(key: string, value: ResolvedWork | null): void {
    this.cache.delete(key);
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, at: Date.now() });
  }
}
