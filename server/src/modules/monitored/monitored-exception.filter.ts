import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

/**
 * Postgres rejects input the API layer never validated (NUL bytes, out-of-range ids, missing FKs).
 * Those are client mistakes, not server faults, and the driver's message names tables, columns and
 * parameter values, so the client gets a fixed generic string instead.
 */
const PG_ERROR_RESPONSES: Record<string, { status: HttpStatus; message: string }> = {
  '22001': { status: HttpStatus.BAD_REQUEST, message: 'Invalid request data' },
  '22003': { status: HttpStatus.BAD_REQUEST, message: 'Invalid request data' },
  '22021': { status: HttpStatus.BAD_REQUEST, message: 'Invalid request data' },
  '22P02': { status: HttpStatus.BAD_REQUEST, message: 'Invalid request data' },
  '23503': { status: HttpStatus.BAD_REQUEST, message: 'Invalid request data' },
  '23505': { status: HttpStatus.CONFLICT, message: 'This record already exists' },
};

const MAX_CAUSE_DEPTH = 5;

interface MappedPgError {
  code: string;
  status: HttpStatus;
  message: string;
  errorClass: string;
  driverMessage: string;
}

/**
 * Drizzle rethrows driver failures wrapped, so the pg error carrying `code` can sit several `cause`
 * hops down. Bounded depth plus a seen-set keeps a self-referencing chain from looping.
 */
function findMappedPgError(exception: unknown): MappedPgError | undefined {
  const seen = new Set<unknown>();
  let node: unknown = exception;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof node !== 'object' || node === null || seen.has(node)) return undefined;
    seen.add(node);

    const candidate = node as Record<string, unknown>;
    const code = typeof candidate.code === 'string' ? candidate.code : undefined;
    const mapped = code ? PG_ERROR_RESPONSES[code] : undefined;

    if (code && mapped) {
      return {
        code,
        status: mapped.status,
        message: mapped.message,
        errorClass: (candidate.constructor as { name?: string } | undefined)?.name ?? 'Object',
        driverMessage: typeof candidate.message === 'string' ? candidate.message : '',
      };
    }

    node = candidate.cause;
  }

  return undefined;
}

/**
 * The monitored routes write rows the API layer cannot fully pre-validate - a work id the catalog
 * dropped between the read and the write, a duplicate that only the unique index can see - so the
 * driver's own rejection is the first place some client mistakes surface. This filter translates
 * those into the status they deserve and hands everything else, and the whole response envelope,
 * back to the application-wide filter it extends.
 */
@Catch()
export class MonitoredExceptionFilter extends GlobalExceptionFilter {
  private readonly monitoredLogger = new Logger(MonitoredExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const mapped = exception instanceof HttpException ? undefined : findMappedPgError(exception);
    if (!mapped) {
      super.catch(exception, host);
      return;
    }
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    this.monitoredLogger.warn(
      `[monitored.request.database_error] [fail] requestId=${sanitizeLogValue(String(request.id))} path="${sanitizeLogValue(request.url)}" pgCode=${sanitizeLogValue(mapped.code)} status=${mapped.status} errorClass=${sanitizeLogValue(mapped.errorClass)} error="${sanitizeLogValue(mapped.driverMessage)}" - database rejected a monitored request`,
    );
    super.catch(new HttpException(mapped.message, mapped.status), host);
  }
}
