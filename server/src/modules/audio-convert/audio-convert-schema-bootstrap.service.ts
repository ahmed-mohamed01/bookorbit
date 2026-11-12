import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { AudioConvertRepository } from './audio-convert.repository';
import { AUDIO_CONVERT_SCHEMA_SQL } from './schema/audio-convert-schema';

export const AUDIO_CONVERT_TABLE_NAMES = ['audio_convert_settings', 'audio_convert_jobs', 'audio_convert_watch'] as const;

// onModuleInit, not onApplicationBootstrap: the tables must exist before the queue recovers its jobs.
@Injectable()
export class AudioConvertSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AudioConvertSchemaBootstrapService.name);

  constructor(private readonly repo: AudioConvertRepository) {}

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();
    try {
      const missing = await this.repo.findMissingTables(AUDIO_CONVERT_TABLE_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(AUDIO_CONVERT_SCHEMA_SQL));
      if (missing.length > 0) {
        this.logger.log(
          `[audio_convert.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} - schema bootstrap completed`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[audio_convert.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
