import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { AudioConvertConverterService } from './audio-convert-converter.service';
import { AudioConvertQueueService } from './audio-convert-queue.service';
import { AudioConvertRepository } from './audio-convert.repository';
import { AudioConvertService, encoderFor } from './audio-convert.service';
import { AudioConvertEncoderDto, AudioConvertRunDto, UpdateAudioConvertSettingsDto } from './dto/audio-convert.dto';
import type { AudioConvertSettingsRow } from './schema/audio-convert.schema';

const settings = {
  id: 1,
  enabled: true,
  autoConvert: false,
  codec: 'aac',
  bitrate: '64k',
  channels: 1,
  embedChapters: true,
  embedMetadata: true,
  backupDays: 14,
  updatedAt: null,
  updatedByUserId: null,
} satisfies AudioConvertSettingsRow;

const filters = { includeTagIds: [], includeGenreIds: [], excludeTagIds: [4], excludeGenreIds: [] };
const manager = { id: 5, isSuperuser: false, permissions: [], contentFilters: filters } as unknown as RequestUser;
const admin = { id: 1, isSuperuser: true, permissions: [], contentFilters: filters } as unknown as RequestUser;

async function setup() {
  const repo = {
    getSettings: vi.fn().mockResolvedValue(settings),
    convertibleBookIds: vi.fn().mockResolvedValue([1, 2, 3]),
    createJob: vi.fn().mockResolvedValue({ id: 'j' }),
    preview: vi.fn().mockResolvedValue({ items: [], total: 0, totalByStatus: {} }),
    cancelQueuedInLibrary: vi.fn().mockResolvedValue(2),
    cancelPendingJob: vi.fn().mockResolvedValue(false),
    latestJob: vi.fn(),
    findJob: vi.fn(),
    convertNow: vi.fn().mockResolvedValue(null),
  };
  const queue = { cancelRunning: vi.fn().mockReturnValue(true) };
  const books = { verifyBookAccess: vi.fn().mockResolvedValue(undefined) };
  const module = await Test.createTestingModule({
    providers: [
      AudioConvertService,
      { provide: AudioConvertRepository, useValue: repo },
      { provide: AudioConvertConverterService, useValue: { plan: vi.fn() } },
      { provide: AudioConvertQueueService, useValue: queue },
      { provide: BookService, useValue: books },
    ],
  }).compile();
  return { service: module.get(AudioConvertService), repo, queue };
}

describe('AudioConvertService', () => {
  it('tells any user the saved encoder defaults along with the flag', async () => {
    const { service } = await setup();
    await expect(service.enabled()).resolves.toEqual({ enabled: true, encoder: { codec: 'aac', bitrate: '64k', channels: 1 } });
  });

  it('uses the saved encoder settings for fields a request leaves out', () => {
    expect(encoderFor({}, settings)).toEqual({ codec: 'aac', bitrate: '64k', channels: 1 });
    expect(encoderFor({ codec: 'copy', channels: null }, settings)).toEqual({ codec: 'copy', bitrate: '64k', channels: null });
  });

  it('runs over the same search and content filters as the preview', async () => {
    const { service, repo } = await setup();
    await service.run(7, { search: 'dune', excludeBookIds: [2] }, manager);
    expect(repo.convertibleBookIds).toHaveBeenCalledWith(7, { search: 'dune', contentFilters: filters });
    expect(repo.createJob).toHaveBeenCalledTimes(2);
    expect(repo.createJob).toHaveBeenCalledWith(expect.objectContaining({ bookId: 3, codec: 'aac', bitrate: '64k', channels: 1 }));

    await service.preview(7, { page: 1, pageSize: 50, search: 'dune' }, manager);
    expect(repo.preview).toHaveBeenCalledWith(7, expect.objectContaining({ search: 'dune', contentFilters: filters }));
    await service.preview(7, { page: 1, pageSize: 50 }, admin);
    expect(repo.preview).toHaveBeenLastCalledWith(7, expect.objectContaining({ contentFilters: undefined }));
  });

  it('stops only the queued jobs of a library', async () => {
    const { service, repo } = await setup();
    await expect(service.stop(7)).resolves.toEqual({ cancelled: 2 });
    expect(repo.cancelQueuedInLibrary).toHaveBeenCalledWith(7);
  });

  it('stops a book job the worker claimed between the read and the cancel', async () => {
    const { service, repo, queue } = await setup();
    repo.latestJob.mockResolvedValue({ id: 'j', status: 'queued' });
    repo.findJob.mockResolvedValue({ id: 'j', status: 'running' });
    await expect(service.stopBook(9, manager)).resolves.toEqual({ cancelled: true });
    expect(queue.cancelRunning).toHaveBeenCalledWith('j');
  });

  it('refuses convert-now while the chapter lookup holds the job', async () => {
    const { service, repo } = await setup();
    repo.findJob.mockResolvedValue({ id: 'j', bookId: 9, status: 'waiting', stage: 'chapters' });
    await expect(service.convertNow('j', manager)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('audio convert DTOs', () => {
  const errors = async <T extends object>(cls: new () => T, body: object) =>
    (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map((error) => error.property);

  it('rejects null for settings that cannot be null, so a PATCH is a 400 rather than a database error', async () => {
    for (const field of ['enabled', 'autoConvert', 'embedChapters', 'embedMetadata', 'backupDays', 'codec', 'bitrate']) {
      expect(await errors(UpdateAudioConvertSettingsDto, { [field]: null })).toEqual([field]);
    }
    expect(await errors(UpdateAudioConvertSettingsDto, { channels: null })).toEqual([]);
    expect(await errors(UpdateAudioConvertSettingsDto, {})).toEqual([]);
  });

  it('validates settings ranges and values', async () => {
    expect(await errors(UpdateAudioConvertSettingsDto, { backupDays: 366 })).toEqual(['backupDays']);
    expect(await errors(UpdateAudioConvertSettingsDto, { backupDays: -1 })).toEqual(['backupDays']);
    expect(await errors(UpdateAudioConvertSettingsDto, { bitrate: '100k' })).toEqual(['bitrate']);
    expect(await errors(UpdateAudioConvertSettingsDto, { codec: 'opus' })).toEqual(['codec']);
    expect(await errors(UpdateAudioConvertSettingsDto, { channels: 3 })).toEqual(['channels']);
    expect(await errors(UpdateAudioConvertSettingsDto, { codec: 'copy', bitrate: '64k', channels: 2, backupDays: 0, autoConvert: true })).toEqual([]);
  });

  it('accepts a search on a run and an empty book body', async () => {
    expect(await errors(AudioConvertRunDto, { search: 'dune', excludeBookIds: [1] })).toEqual([]);
    expect(await errors(AudioConvertEncoderDto, {})).toEqual([]);
    expect(await errors(AudioConvertEncoderDto, { codec: null })).toEqual(['codec']);
  });
});
