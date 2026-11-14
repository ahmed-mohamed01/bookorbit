import { Test } from '@nestjs/testing';
import { describe, it, expect, vi } from 'vitest';
import { AudioPlayOrderService } from '../audiobook-chapters/audio-play-order.service';
import { AudiobookshelfAudioPositionService } from './audiobookshelf-audio-position.service';

function makeFiles() {
  return { files: [{ id: 11, absolutePath: '/books/track.mp3', format: 'mp3', sortOrder: 1, durationSeconds: 100 as number | null }] };
}

async function makeFixture() {
  const chapterRepo = {
    findTrackRows: vi.fn().mockResolvedValue(makeFiles().files),
    findChapterState: vi.fn().mockResolvedValue(null),
  };
  const module = await Test.createTestingModule({
    providers: [AudiobookshelfAudioPositionService, { provide: AudioPlayOrderService, useValue: new AudioPlayOrderService(chapterRepo as never) }],
  }).compile();
  return { chapterRepo, service: module.get(AudiobookshelfAudioPositionService) };
}

describe('AudiobookshelfAudioPositionService', () => {
  it('uses player order and chapter boundaries for rounded file durations', async () => {
    const fixture = await makeFixture();
    const base = makeFiles().files[0]!;
    fixture.chapterRepo.findTrackRows.mockResolvedValue([
      { ...base, id: 12, sortOrder: 2, durationSeconds: 100 },
      { ...base, id: 11, sortOrder: 1, durationSeconds: 20 },
    ]);
    fixture.chapterRepo.findChapterState.mockResolvedValue({
      chapters: [
        { startMs: 0, title: '' },
        { startMs: 20500, title: '' },
      ],
    });

    await expect(fixture.service.resolveAudioBookPosition(5, 12, 75)).resolves.toEqual({ audioSeconds: 95.5, audioTotalSeconds: 120.5 });
    await expect(fixture.service.resolveAudioBookPosition(5, 12, -5)).resolves.toEqual({ audioSeconds: 20.5, audioTotalSeconds: 120.5 });
    await expect(fixture.service.resolveAudioBookPosition(5, 12, 200)).resolves.toEqual({ audioSeconds: 120.5, audioTotalSeconds: 120.5 });
    await expect(fixture.service.resolveAudioBookPosition(5, 99, 75)).resolves.toBeNull();
  });

  it('returns no position when an audio duration is missing', async () => {
    const fixture = await makeFixture();
    const files = makeFiles();
    files.files[0]!.durationSeconds = null;
    fixture.chapterRepo.findTrackRows.mockResolvedValue(files.files);

    await expect(fixture.service.resolveAudioBookPosition(5, files.files[0]!.id, 10)).resolves.toBeNull();
  });
});
