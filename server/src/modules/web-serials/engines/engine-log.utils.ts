import type { Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { describeError } from '../web-serials-log.utils';
import { errorMessage } from './engine-http.utils';

const SEARCH_EVENT = 'web_serials.novel_search';

/** The health and search log lines both novel engines write, so their fields never drift apart. */
export function logEngineHealthEnd(logger: Logger, event: string, startedAt: number, searchableSources: number): void {
  logger.log(`[${event}] [end] durationMs=${Date.now() - startedAt} searchableSources=${searchableSources} - engine health check completed`);
}

/** Logs a failed health check and returns the message the check reports. */
export function logEngineHealthFail(logger: Logger, event: string, startedAt: number, error: unknown): string {
  const message = errorMessage(error);
  logger.warn(
    `[${event}] [fail] durationMs=${Date.now() - startedAt} errorClass=${describeError(error).errorClass} error="${sanitizeLogValue(message)}" - engine health check failed`,
  );
  return message;
}

export function logNovelSearchStart(logger: Logger, engine: string, sourceCount: number, queryLength: number): void {
  logger.log(`[${SEARCH_EVENT}] [start] engine=${engine} sourceCount=${sourceCount} queryLength=${queryLength} - engine search started`);
}

export function logNovelSearchEnd(logger: Logger, engine: string, startedAt: number, hits: number, failedSources: number): void {
  logger.log(
    `[${SEARCH_EVENT}] [end] engine=${engine} durationMs=${Date.now() - startedAt} hits=${hits} failedSources=${failedSources} - engine search completed`,
  );
}
