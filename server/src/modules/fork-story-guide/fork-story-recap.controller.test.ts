import { EventEmitter } from 'node:events';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { makeUser } from '../../common/test-utils/make-user';
import { ForkStoryRecapController } from './fork-story-recap.controller';
import { StoryRecapService } from './story-recap.service';
import type { ForkStoryRecap } from '@bookorbit/types';

const user = makeUser();
const skipped: ForkStoryRecap = { state: 'no-position', cut: null, previously: [], stop: { state: 'skipped' } };

describe('ForkStoryRecapController', () => {
  it('serves recap JSON and validates stop on the Fastify route', async () => {
    const recap = vi.fn<StoryRecapService['recap']>().mockResolvedValue(skipped);
    const module = await Test.createTestingModule({
      controllers: [ForkStoryRecapController],
      providers: [{ provide: StoryRecapService, useValue: { recap } }],
    }).compile();

    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', (request, _, done) => {
      Object.assign(request, { user });
      done();
    });
    const app = module.createNestApplication<NestFastifyApplication>(adapter);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    try {
      await app.init();
      const url = '/api/v1/story-guide-content/files/12/recap';
      const response = await app.inject({ url: `${url}?stop=0`, headers: { 'accept-language': 'pt-BR' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(skipped);
      expect(recap).toHaveBeenCalledExactlyOnceWith(12, user, false, 'pt-BR', expect.any(AbortSignal));

      expect((await app.inject({ url: `${url}?stop=2` })).statusCode).toBe(400);
      expect(recap).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('throttles the recap route like reading help', () => {
    const handler = ForkStoryRecapController.prototype.recap;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('aborts on close, removes the listener and skips sending on a destroyed connection', async () => {
    const raw = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
    const send = vi.fn();
    const header = vi.fn().mockReturnValue({ send });
    const reply = { raw, header } as unknown as FastifyReply;
    const recap = vi.fn<StoryRecapService['recap']>((_file, _user, _stop, _language, signal) => {
      expect(signal.aborted).toBe(false);
      raw.destroyed = true;
      raw.emit('close');
      expect(signal.aborted).toBe(true);
      return Promise.resolve(skipped);
    });
    const module = await Test.createTestingModule({
      controllers: [ForkStoryRecapController],
      providers: [{ provide: StoryRecapService, useValue: { recap } }],
    }).compile();

    await module.get(ForkStoryRecapController).recap(12, {}, user, reply);
    expect(recap).toHaveBeenCalledWith(12, user, true, undefined, expect.any(AbortSignal));
    expect(raw.listenerCount('close')).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
