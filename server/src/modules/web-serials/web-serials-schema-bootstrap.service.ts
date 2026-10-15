import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { describeError } from './web-serials-log.utils';
import { WebSerialsRepository, type WebSerialInterruptedJobs } from './web-serials.repository';
import { WEB_SERIALS_SCHEMA_SQL, WEB_SERIALS_TABLE_NAMES } from './schema/web-serials-schema';

const BOOTSTRAP_EVENT = 'web_serials.schema_bootstrap';

@Injectable()
export class WebSerialsSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebSerialsSchemaBootstrapService.name);
  private settle!: { resolve: (interrupted: WebSerialInterruptedJobs) => void; reject: (error: unknown) => void };
  /**
   * Settles once the schema is applied and jobs a restart interrupted are back in the queue. Nest runs
   * the bootstrap hooks of one module concurrently, so the job runner waits on this rather than on hook order.
   */
  readonly ready: Promise<WebSerialInterruptedJobs>;

  constructor(private readonly repo: WebSerialsRepository) {
    this.ready = new Promise<WebSerialInterruptedJobs>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready.catch(() => undefined);
  }

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(WEB_SERIALS_TABLE_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(WEB_SERIALS_SCHEMA_SQL));
      const interrupted = await this.repo.requeueInterruptedJobs();

      if (missing.length > 0 || interrupted.requeued.length > 0) {
        this.logger.log(
          `[${BOOTSTRAP_EVENT}] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} interruptedJobsRequeued=${interrupted.requeued.length} - schema bootstrap completed`,
        );
      }
      this.settle.resolve(interrupted);
    } catch (err) {
      this.settle.reject(err);
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${BOOTSTRAP_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
