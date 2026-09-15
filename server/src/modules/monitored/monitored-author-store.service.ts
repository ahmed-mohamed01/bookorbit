import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class MonitoredAuthorStoreService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async deleteOrphanAuthor(authorId: number): Promise<boolean> {
    const deleted = await this.db
      .delete(authors)
      .where(
        and(
          eq(authors.id, authorId),
          sql`NOT EXISTS (SELECT 1 FROM ${bookAuthors} WHERE ${bookAuthors.authorId} = ${authors.id})`,
          sql`NOT EXISTS (SELECT 1 FROM monitored_authors WHERE monitored_authors.local_author_id = ${authors.id})`,
        ),
      )
      .returning({ id: authors.id });
    return deleted.length > 0;
  }
}
