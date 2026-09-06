import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { EditionLinkRepository } from './edition-link.repository';
import { EDITION_LINK_SCHEMA_SQL } from './schema/edition-link-schema';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

@Injectable()
export class EditionLinkSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EditionLinkSchemaBootstrapService.name);

  constructor(private readonly repo: EditionLinkRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('[edition_link.schema_bootstrap] [start] - schema bootstrap started');

    try {
      const statements = EDITION_LINK_SCHEMA_SQL.split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean);

      await this.repo.applySchemaStatements(statements);

      this.logger.log(`[edition_link.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} - schema bootstrap completed`);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[edition_link.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
