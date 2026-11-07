import type { FastifyReply } from 'fastify';
import { sendImageConditional } from './image-conditional.utils';

describe('sendImageConditional', () => {
  it.each([true, false])('sets validators and cache policy versioned=%s', (versioned) => {
    const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    expect(sendImageConditional(reply as unknown as FastifyReply, { mtimeMs: 1234.9, versioned })).toBe(false);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('ETag', '"1234"');
    expect(reply.send).not.toHaveBeenCalled();
    expect(sendImageConditional(reply as unknown as FastifyReply, { mtimeMs: 1234.9, versioned, ifNoneMatch: '"1234"' })).toBe(true);
    expect(reply.status).toHaveBeenCalledWith(304);
    expect(reply.send).toHaveBeenCalledWith();
  });
  it('does not send 304 for an outdated validator', () => {
    const reply = { header: vi.fn(), status: vi.fn(), send: vi.fn() };
    expect(sendImageConditional(reply as unknown as FastifyReply, { mtimeMs: 2000, versioned: false, ifNoneMatch: '"1234"' })).toBe(false);
    expect(reply.status).not.toHaveBeenCalled();
  });
});
