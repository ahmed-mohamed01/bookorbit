import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { Permission } from '@bookorbit/types';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { StorytellerReadAlongStatusService } from './storyteller-read-along-status.service';
import { StorytellerSettingsService } from './storyteller-settings.service';
import { StorytellerController } from './storyteller.controller';

const USER = { id: 42 } as RequestUser;

async function setup() {
  const settingsService = {
    getSettings: vi.fn().mockResolvedValue({ serverUrl: null }),
    upsertSettings: vi.fn().mockResolvedValue({ serverUrl: 'http://storyteller' }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  };
  const statusService = {
    requestBuild: vi.fn().mockResolvedValue({ status: 'building', blocked: null }),
    getStatus: vi.fn().mockResolvedValue({ status: 'none', blocked: null }),
    findExisting: vi.fn().mockResolvedValue({ matches: [] }),
  };
  const module = await Test.createTestingModule({
    controllers: [StorytellerController],
    providers: [
      { provide: StorytellerSettingsService, useValue: settingsService },
      { provide: StorytellerReadAlongStatusService, useValue: statusService },
    ],
  }).compile();
  return { controller: module.get(StorytellerController), settingsService, statusService };
}

describe('StorytellerController', () => {
  it('delegates all settings routes with the current user', async () => {
    const { controller, settingsService } = await setup();
    const dto = { serverUrl: 'http://storyteller' };

    // The settings read is permission-gated but not user-scoped, so it takes no user parameter.
    await controller.getSettings();
    await controller.updateSettings(dto, USER);
    await controller.testConnection({ serverUrl: 'http://storyteller' }, USER);

    expect(settingsService.getSettings).toHaveBeenCalledOnce();
    expect(settingsService.upsertSettings).toHaveBeenCalledWith(dto, USER);
    expect(settingsService.testConnection).toHaveBeenCalledWith(USER, { serverUrl: 'http://storyteller' });
  });

  it('delegates build, status, and existing-match routes', async () => {
    const { controller, statusService } = await setup();
    const dto = { force: true };

    await controller.requestBuild(10, dto, USER);
    await controller.getStatus(10, USER);
    await controller.findExisting(10, USER);

    expect(statusService.requestBuild).toHaveBeenCalledWith(10, USER, dto);
    expect(statusService.getStatus).toHaveBeenCalledWith(10, USER);
    expect(statusService.findExisting).toHaveBeenCalledWith(10, USER);
  });

  it('declares the expected route paths and methods', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StorytellerController)).toBe('storyteller');
    expect(Reflect.getMetadata(PATH_METADATA, StorytellerController.prototype.getSettings)).toBe('settings');
    expect(Reflect.getMetadata(METHOD_METADATA, StorytellerController.prototype.getSettings)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, StorytellerController.prototype.requestBuild)).toBe('read-along/books/:bookId/build');
    expect(Reflect.getMetadata(METHOD_METADATA, StorytellerController.prototype.requestBuild)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, StorytellerController.prototype.getStatus)).toBe('read-along/books/:bookId/status');
    expect(Reflect.getMetadata(PATH_METADATA, StorytellerController.prototype.findExisting)).toBe('read-along/books/:bookId/existing');
  });

  it('applies permissions to the sensitive routes only', () => {
    for (const method of ['getSettings', 'updateSettings', 'testConnection'] as const) {
      expect(Reflect.getMetadata(PERMISSION_KEY, StorytellerController.prototype[method])).toBe(Permission.ManageAppSettings);
    }
    expect(Reflect.getMetadata(PERMISSION_KEY, StorytellerController.prototype.requestBuild)).toBe(Permission.LibraryUpload);
    expect(Reflect.getMetadata(PERMISSION_KEY, StorytellerController.prototype.findExisting)).toBe(Permission.LibraryUpload);
  });

  // The read-along row renders for every reader who can open the book, so any permission here
  // (LibraryUpload being the only candidate) would blank it for ordinary readers. Book access is the
  // gate, and what a reader may not see is masked inside the response instead - status is the one
  // route in this controller allowed to carry no permission, and only that one.
  it('leaves the status poll open to any reader of the book, and nothing else', () => {
    const routeMethods = ['getSettings', 'updateSettings', 'testConnection', 'requestBuild', 'getStatus', 'findExisting'] as const;
    const ungated = routeMethods.filter((method) => Reflect.getMetadata(PERMISSION_KEY, StorytellerController.prototype[method]) === undefined);

    expect(ungated).toEqual(['getStatus']);
  });

  it('returns HTTP 202 for build requests', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, StorytellerController.prototype.requestBuild)).toBe(202);
  });
});
