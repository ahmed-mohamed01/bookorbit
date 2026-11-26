import { ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INTERACTIVE_ONLY_KEY } from '../../common/decorators/api-key-policy.decorator';
import { makeUser } from '../../common/test-utils/make-user';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { ForkStoryGuideContentController } from './fork-story-guide-content.controller';

function makeReply() {
  const reply = { status: vi.fn(), header: vi.fn(), send: vi.fn() };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  return { reply, asFastifyReply: reply as unknown as FastifyReply };
}

describe('ForkStoryGuideContentController', () => {
  const fileId = 42;
  const user = makeUser({ credential: { kind: 'session', sessionId: 7 } });
  const etag = '"guide.f1"';
  const builtAt = '2026-11-21T00:00:00Z';
  const body = { format: 1, textKey: 'book-text-key', builtAt, entities: [], chronicle: { version: 1, basis: builtAt, entities: {} } };
  const content = vi.fn<StoryGuidesService['content']>();
  let controller: ForkStoryGuideContentController;

  beforeEach(async () => {
    content.mockReset().mockResolvedValue({ kind: 'found', body, etag });
    const module = await Test.createTestingModule({
      controllers: [ForkStoryGuideContentController],
      providers: [{ provide: StoryGuidesService, useValue: { content } }],
    }).compile();
    controller = module.get(ForkStoryGuideContentController);
  });

  it("serves the row body with its chronicle and upstream's ETag", async () => {
    const { reply, asFastifyReply } = makeReply();

    await controller.read(fileId, {}, user, asFastifyReply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('ETag', etag);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    expect(reply.send).toHaveBeenCalledWith(body);
  });

  it('sends a bodyless 304 with the ETag for a matching If-None-Match', async () => {
    content.mockResolvedValue({ kind: 'not-modified', etag });
    const { reply, asFastifyReply } = makeReply();

    await controller.read(fileId, {}, user, asFastifyReply, etag);

    expect(content).toHaveBeenCalledWith(fileId, [1], user, etag);
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
    expect(reply.header).toHaveBeenCalledWith('ETag', etag);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    expect(reply.send).toHaveBeenCalledWith();
  });

  it('sends a 404 with the reason when no guide exists', async () => {
    content.mockResolvedValue({ kind: 'missing', reason: 'none' });
    const { reply, asFastifyReply } = makeReply();

    await controller.read(fileId, {}, user, asFastifyReply);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    expect(reply.send).toHaveBeenCalledWith({ reason: 'none' });
  });

  it.each([
    { format: '1,2', formats: [1, 2] },
    { format: undefined, formats: [1] },
  ])('passes $formats to the service for format $format', async ({ format, formats }) => {
    content.mockResolvedValue({ kind: 'missing', reason: 'none' });
    const { asFastifyReply } = makeReply();

    await controller.read(fileId, { format }, user, asFastifyReply);

    expect(content).toHaveBeenCalledWith(fileId, formats, user, undefined);
  });

  it('marks the controller as interactive only', () => {
    const reflector = new Reflector();

    expect(reflector.get(INTERACTIVE_ONLY_KEY, ForkStoryGuideContentController)).toBe(true);
  });

  it.each([new NotFoundException(), new ForbiddenException()])('propagates $name from the service', async (error) => {
    content.mockRejectedValue(error);
    const { asFastifyReply } = makeReply();

    await expect(controller.read(fileId, {}, user, asFastifyReply)).rejects.toBe(error);
  });
  it("brings the BK extras in line with the guide's entities after reader fixes", async () => {
    const fixed = {
      ...body,
      entities: [{ key: 'a', joins: [], profiles: [{ through: { s: 0, o: 1, q: 'x' }, text: 'Fixed profile' }] }],
      links: [
        { a: 'a', b: 'gone', at: { s: 0, o: 1 } },
        { a: 'a', b: 'a', at: { s: 0, o: 1 } },
      ],
      chronicle: { version: 1, basis: builtAt, entities: { a: { about: [{ through: { s: 0, o: 1, q: 'x' }, text: 'Old' }] }, gone: { about: [] } } },
    };
    content.mockResolvedValue({ kind: 'found', body: fixed, etag });
    const { reply, asFastifyReply } = makeReply();

    await controller.read(fileId, {}, user, asFastifyReply);

    const sent = reply.send.mock.calls[0][0];
    expect(sent.chronicle.entities).toEqual({ a: { about: [{ through: { s: 0, o: 1, q: 'x' }, text: 'Fixed profile' }] } });
    expect(sent.links).toEqual([]);
    expect(reply.header).toHaveBeenCalledWith('ETag', etag);
  });
});
