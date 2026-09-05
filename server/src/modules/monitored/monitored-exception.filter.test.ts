import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoredExceptionFilter } from './monitored-exception.filter';

function makeHost() {
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  const reply = { status, sent: false };
  const request = { url: '/api/v1/monitored/books', id: 'req-123' };

  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  return { host, status, send };
}

function makePgError(code: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint "monitored_books_owner_monitor_work_uidx"'), { code });
}

describe('MonitoredExceptionFilter', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['22001', HttpStatus.BAD_REQUEST, 'Invalid request data'],
    ['22003', HttpStatus.BAD_REQUEST, 'Invalid request data'],
    ['22021', HttpStatus.BAD_REQUEST, 'Invalid request data'],
    ['22P02', HttpStatus.BAD_REQUEST, 'Invalid request data'],
    ['23503', HttpStatus.BAD_REQUEST, 'Invalid request data'],
    ['23505', HttpStatus.CONFLICT, 'This record already exists'],
  ])('maps pg error %s to %i with a generic message instead of the driver text', (code, expectedStatus, expectedMessage) => {
    const { host, status, send } = makeHost();

    new MonitoredExceptionFilter().catch(makePgError(code), host);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: expectedStatus,
        message: expectedMessage,
        path: '/api/v1/monitored/books',
        requestId: 'req-123',
      }),
    );
  });

  it('never echoes the driver message, which names the table, column and value that failed', () => {
    const { host, send } = makeHost();

    new MonitoredExceptionFilter().catch(makePgError('23505'), host);

    const body = send.mock.calls[0][0] as { message: string };
    expect(body.message).not.toContain('monitored_books_owner_monitor_work_uidx');
    expect(body.message).not.toContain('duplicate key');
  });

  it('warns instead of logging a mapped driver error as a server fault', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = makeHost();

    new MonitoredExceptionFilter().catch(makePgError('22021'), host);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('[monitored.request.database_error] [fail]'));
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('pgCode=22021'));
  });

  /** Drizzle rethrows the driver failure wrapped, so the code is only reachable down the cause chain. */
  it('finds the pg code through nested cause wrappers', () => {
    const { host, status, send } = makeHost();
    const outer = new Error('Failed query: insert into "monitored_books"', {
      cause: new Error('driver call failed', { cause: makePgError('23503') }),
    });

    new MonitoredExceptionFilter().catch(outer, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid request data' }));
  });

  it('stops at a self-referencing cause chain instead of looping', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, status } = makeHost();
    const looping = new Error('outer') as Error & { cause?: unknown };
    looping.cause = looping;

    new MonitoredExceptionFilter().catch(looping, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('leaves an unmapped pg code as a logged 500', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, status, send } = makeHost();

    new MonitoredExceptionFilter().catch(makePgError('42P01'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'Internal server error' }));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps the HttpException status when the thrown exception happens to carry a code', () => {
    const { host, status, send } = makeHost();
    const exception = Object.assign(new BadRequestException('This work is already monitored'), { code: '23505' });

    new MonitoredExceptionFilter().catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'This work is already monitored' }));
  });

  it('hands a plain HttpException straight to the application-wide envelope', () => {
    const { host, status, send } = makeHost();

    new MonitoredExceptionFilter().catch(new HttpException('nope', HttpStatus.FORBIDDEN), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ statusCode: HttpStatus.FORBIDDEN, message: 'nope' }));
  });
});
