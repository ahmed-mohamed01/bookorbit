import { HttpException } from '@nestjs/common';
import { EngineCredentialsRejectedException, engineFailureOf, type EngineFailure } from './engines/engine-http.utils';

export type FailureReason =
  | 'source_unavailable'
  | 'source_images_failed'
  | 'source_blocked'
  | 'not_found'
  | 'engine_unreachable'
  | 'engine_job_lost'
  | 'engine_credentials'
  | 'unknown';

const RETRYABLE: ReadonlySet<FailureReason> = new Set(['source_unavailable', 'source_images_failed', 'engine_unreachable', 'engine_job_lost']);

const BLOCKED = /(?:http(?: error)?|status)\s*(?:403|429)\b|forbidden|captcha|blocked|access denied|too many requests/i;
const NOT_FOUND = /(?:http(?: error)?|status)\s*(?:404|410)\b|not found|no longer (?:exists|available)|does not exist/i;
const IMAGES = /cdn attempts failed|chapter download failed|image (?:server|download)/i;
const UNAVAILABLE =
  /(?:http(?: error)?|status)\s*5\d\d\b|timed out|timeout|did not answer in time|econnreset|econnrefused|enotfound|etimedout|socket|unreachable|connection (?:reset|refused)|temporarily|unavailable|could not be fetched/i;
const HTTP_5XX = /(?:http(?: error)?|status)\s*5\d\d\b/i;
const ENGINE_DOWN = /could not be reached|downloader is stopped/i;
const JOB_GONE = /rejected the request with status 404/i;

/** A poll answered 404: the engine no longer knows the job it was asked about (restart, cleanup). */
export function isEngineJobGone(input: unknown): boolean {
  return input instanceof HttpException && JOB_GONE.test(input.message);
}

export function isRetryableFailure(reason: FailureReason): boolean {
  return RETRYABLE.has(reason);
}

/** Maps an engine error or failure text to a reason code. HTTP exceptions from the engine client are classified by status and message. */
export function classifyFailure(input: unknown): FailureReason {
  if (input instanceof EngineCredentialsRejectedException) return 'engine_credentials';
  const failure = engineFailureOf(input);
  const structured = failure ? classifyEngineFailure(failure) : null;
  if (structured) return structured;
  if (input instanceof HttpException) {
    const message = input.message;
    if (ENGINE_DOWN.test(message)) return 'engine_unreachable';
    if (input.getStatus() === 504 || /did not answer in time/i.test(message)) return 'source_unavailable';
    if (/answered with status 5\d\d/i.test(message)) return 'source_unavailable';
    return classifyText(message);
  }
  if (input instanceof Error) return classifyText(input.message);
  return typeof input === 'string' ? classifyText(input) : 'unknown';
}

const SOURCE_CODES: Record<string, FailureReason> = {
  TIMEOUT: 'source_unavailable',
  SITE_FAILED: 'source_unavailable',
  CHALLENGE: 'source_blocked',
  PLUGIN_ERROR: 'unknown',
};

/** Null when the structure says nothing decisive, so the message text decides. */
function classifyEngineFailure(failure: EngineFailure): FailureReason | null {
  const byCode = failure.code ? SOURCE_CODES[failure.code] : undefined;
  if (byCode) return byCode;
  if (failure.status >= 500) return 'source_unavailable';
  if (failure.status === 404 || failure.status === 410) return 'not_found';
  return null;
}

export function classifyText(text: string): FailureReason {
  if (ENGINE_DOWN.test(text)) return 'engine_unreachable';
  if (IMAGES.test(text)) return 'source_images_failed';
  if (HTTP_5XX.test(text)) return 'source_unavailable';
  if (BLOCKED.test(text)) return 'source_blocked';
  if (NOT_FOUND.test(text)) return 'not_found';
  if (UNAVAILABLE.test(text)) return 'source_unavailable';
  return 'unknown';
}

export function failureText(reason: FailureReason, sourceName: string, noun = 'chapter'): string | null {
  switch (reason) {
    case 'source_unavailable':
      return `${sourceName} isn't responding right now.`;
    case 'source_images_failed':
      return `${sourceName}'s image server failed for this ${noun}.`;
    case 'source_blocked':
      return `${sourceName} refused the request (it may be blocking automated downloads).`;
    case 'not_found':
      return `${sourceName} no longer has this ${noun}.`;
    case 'engine_unreachable':
      return 'The download service is not reachable.';
    case 'engine_credentials':
      return 'The download service rejected its credentials. Ask an admin to check the connection settings.';
    case 'engine_job_lost':
      return 'The download service lost track of this download.';
    case 'unknown':
      return null;
  }
}

export function failedUnitsMessage(counts: Map<FailureReason, number>, failed: number, noun: string, sourceName: string): string {
  const base = `${failed} ${noun}${failed === 1 ? '' : 's'} could not be downloaded`;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const only = counts.size === 1 && total === failed ? [...counts.keys()][0]! : null;
  const text = only ? failureText(only, sourceName, noun) : null;
  if (only && text) return `${base}: ${text}${isRetryableFailure(only) ? ' Try again later.' : ''}`;
  return `${base} from ${sourceName}.`;
}
