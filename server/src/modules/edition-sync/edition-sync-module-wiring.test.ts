import { Global, Module, type Provider } from '@nestjs/common';
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { READ_ALOUD_HOOKS } from '../read-aloud/read-aloud-hooks';
import { ReadAloudWorkerService } from '../read-aloud/read-aloud-worker.service';
import { EditionSyncReadAloudHooksService } from './edition-sync-read-aloud-hooks.service';
import { EditionSyncModule } from './edition-sync.module';

const hooksProvider = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EditionSyncModule) as Provider[]).find(
  (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === READ_ALOUD_HOOKS,
);

describe('EditionSyncModule wiring', () => {
  it('is global and exports the read-aloud hooks token', () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, EditionSyncModule)).toBe(true);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, EditionSyncModule)).toContain(READ_ALOUD_HOOKS);
    expect(hooksProvider).toEqual({ provide: READ_ALOUD_HOOKS, useExisting: EditionSyncReadAloudHooksService });
  });

  it('hands the dispatcher in another module the edition sync hooks', async () => {
    @Global()
    @Module({ providers: [EditionSyncReadAloudHooksService, hooksProvider!], exports: [READ_ALOUD_HOOKS] })
    class HooksHost {}

    @Module({ providers: [ReadAloudWorkerService] })
    class Dispatcher {}

    const moduleRef = await Test.createTestingModule({ imports: [HooksHost, Dispatcher] })
      .useMocker(() => ({}))
      .compile();
    const dispatcher = moduleRef.get(ReadAloudWorkerService);
    const hooks = (dispatcher as unknown as { hooks: unknown }).hooks;
    expect(hooks).toBeInstanceOf(EditionSyncReadAloudHooksService);
    expect(hooks).toBe(moduleRef.get(EditionSyncReadAloudHooksService));
  });
});
