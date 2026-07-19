import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

@Injectable()
export class AudiobookshelfSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AudiobookshelfSchemaBootstrapService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('[abs.schema_bootstrap] [start] - schema bootstrap started');

    try {
      const schemaSql = await readFile(join(__dirname, 'schema', 'audiobookshelf-schema.sql'), 'utf8');
      const statements = schemaSql
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await this.db.execute(sql.raw(statement));
      }

      this.logger.log(`[abs.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} - schema bootstrap completed`);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[abs.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
