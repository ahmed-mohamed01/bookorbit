import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { BadRequestException } from '@nestjs/common';
import { openSseStream, streamReleaseSearch } from './sse-stream.utils';

function reply() {
  const raw = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroyed: false,
    writableEnded: false,
  });
  return { raw, hijack: vi.fn() };
}

describe('openSseStream', () => {
  it('writes named JSON events and closes idempotently', () => {
    const response = reply();
    const stream = openSseStream(response as unknown as FastifyReply);
    stream.send('progress', { pending: [] });
    expect(response.raw.write).toHaveBeenCalledWith('event: progress\ndata: {"pending":[]}\n\n');
    stream.close();
    stream.close();
    stream.send('result', {});
    expect(response.raw.end).toHaveBeenCalledTimes(1);
    expect(response.raw.write).toHaveBeenCalledTimes(1);
    expect(response.raw.listenerCount('close')).toBe(0);
  });

  it.each(['close', 'aborted'])('stops writing on %s', (event) => {
    const response = reply();
    const stream = openSseStream(response as unknown as FastifyReply);
    response.raw.emit(event);
    stream.send('result', {});
    stream.close();
    expect(stream.isClosed()).toBe(true);
    expect(response.raw.write).not.toHaveBeenCalled();
    expect(response.raw.end).not.toHaveBeenCalled();
  });

  it.each([new BadRequestException('Invalid search'), new Error('secret')])('sends a safe terminal error', async (error) => {
    const response = reply();
    await streamReleaseSearch(response as unknown as FastifyReply, () => Promise.reject(error), 'requestId=1');
    const message = error instanceof BadRequestException ? 'Invalid search' : 'Release search failed';
    expect(response.raw.write).toHaveBeenCalledWith(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    expect(response.raw.end).toHaveBeenCalledTimes(1);
  });
});
