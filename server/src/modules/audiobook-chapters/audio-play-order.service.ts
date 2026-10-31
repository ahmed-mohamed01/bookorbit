import { Injectable } from '@nestjs/common';
import { orderAudiobookTracks, resolveStoredAudiobookChapters } from '../../common/utils/audiobook-chapters.utils';
import { snapAudioFileStarts } from '../../common/utils/audio-timeline.utils';
import { AudiobookChaptersRepository } from './audiobook-chapters.repository';

@Injectable()
export class AudioPlayOrderService {
  constructor(private readonly repo: AudiobookChaptersRepository) {}

  async resolveAudioPlayOrder(bookId: number) {
    const [rows, state] = await Promise.all([this.repo.findTrackRows(bookId), this.repo.findChapterState(bookId)]);
    const files = orderAudiobookTracks(rows);
    const chapters = resolveStoredAudiobookChapters(state?.chapters, files) ?? [];
    return snapAudioFileStarts(
      files.map((file) => ({ fileId: file.id, absolutePath: file.absolutePath, durationSeconds: file.durationSeconds })),
      chapters.map((chapter) => chapter.startMs),
    );
  }
}
