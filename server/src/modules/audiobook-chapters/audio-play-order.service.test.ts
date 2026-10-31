import { Test } from '@nestjs/testing';
import { expect, it, vi } from 'vitest';
import { AudioPlayOrderService } from './audio-play-order.service';
import { AudiobookChaptersRepository } from './audiobook-chapters.repository';

it('orders player tracks and snaps rounded boundaries to stored chapters', async () => {
  const repo = {
    findTrackRows: vi.fn().mockResolvedValue([
      { id: 12, absolutePath: '/12.mp3', format: 'mp3', sortOrder: 2, durationSeconds: 100 },
      { id: 11, absolutePath: '/11.mp3', format: 'mp3', sortOrder: 1, durationSeconds: 20 },
    ]),
    findChapterState: vi.fn().mockResolvedValue({
      chapters: [
        { title: 'First', startMs: 0 },
        { title: 'Second', startMs: 20500 },
      ],
    }),
  };
  const module = await Test.createTestingModule({
    providers: [AudioPlayOrderService, { provide: AudiobookChaptersRepository, useValue: repo }],
  }).compile();
  await expect(module.get(AudioPlayOrderService).resolveAudioPlayOrder(42)).resolves.toEqual([
    { fileId: 11, absolutePath: '/11.mp3', durationSeconds: 20, startSeconds: 0 },
    { fileId: 12, absolutePath: '/12.mp3', durationSeconds: 100, startSeconds: 20.5 },
  ]);
});
