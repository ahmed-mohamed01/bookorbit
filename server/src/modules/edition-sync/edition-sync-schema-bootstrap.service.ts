import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { EditionSyncRepository } from './edition-sync.repository';
import { EDITION_SYNC_SCHEMA_SQL } from './schema/edition-sync-schema';

export const EDITION_SYNC_TABLE_NAMES = [
  'edition_sync_user_settings',
  'edition_sync_book_overrides',
  'edition_sync_book_index',
  'edition_sync_settings',
  'edition_sync_runs',
] as const;

// onModuleInit, not onApplicationBootstrap: the tables must exist before any edition-sync service boots its schedule.
@Injectable()
export class EditionSyncSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(EditionSyncSchemaBootstrapService.name);

  constructor(private readonly repo: EditionSyncRepository) {}

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();
    try {
      const missing = await this.repo.findMissingTables(EDITION_SYNC_TABLE_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(EDITION_SYNC_SCHEMA_SQL));
      if (missing.length > 0) {
        this.logger.log(
          `[edition_sync.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} - schema bootstrap completed`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[edition_sync.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
