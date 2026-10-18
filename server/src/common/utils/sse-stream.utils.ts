import { HttpException, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RELEASE_SEARCH_ERROR_EVENT, RELEASE_SEARCH_PROGRESS_EVENT, RELEASE_SEARCH_RESULT_EVENT } from '@bookorbit/types';
import type { ReleaseSearchProgress, ReleaseSearchResult } from '@bookorbit/types';

import { sanitizeLogValue } from './log-sanitize.utils';

const logger = new Logger('ReleaseSearchStream');

export function openSseStream(reply: FastifyReply) {
  let disconnected = false;
  const markDisconnected = () => {
    disconnected = true;
  };
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.on('close', markDisconnected);
  reply.raw.on('aborted', markDisconnected);
  const isClosed = () => disconnected || reply.raw.destroyed || reply.raw.writableEnded;
  return {
    isClosed,
    send(event: string, data: unknown) {
      if (!isClosed()) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      reply.raw.off('close', markDisconnected);
      reply.raw.off('aborted', markDisconnected);
      if (!isClosed()) reply.raw.end();
      disconnected = true;
    },
  };
}

export async function streamReleaseSearch(
  reply: FastifyReply,
  search: (onProgress: (progress: ReleaseSearchProgress) => void) => Promise<ReleaseSearchResult>,
  logIds: string,
) {
  const startedAt = Date.now();
  const stream = openSseStream(reply);
  try {
    const result = await search((progress) => stream.send(RELEASE_SEARCH_PROGRESS_EVENT, progress));
    stream.send(RELEASE_SEARCH_RESULT_EVENT, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.warn(
      `[book_request.release_search_stream] [fail] ${logIds} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - streamed release search failed`,
    );
    stream.send(RELEASE_SEARCH_ERROR_EVENT, { message: error instanceof HttpException ? error.message : 'Release search failed' });
  } finally {
    stream.close();
  }
}
