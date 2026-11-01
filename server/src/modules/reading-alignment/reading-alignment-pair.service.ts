import { Injectable, Optional } from '@nestjs/common';

import { EditionSyncFallbackService } from '../edition-sync/edition-sync-fallback.service';
import { ReadingAlignmentRepository } from './reading-alignment.repository';

export interface ReadingAlignmentPair {
  textBookId: number;
  audioBookId: number;
}

@Injectable()
export class ReadingAlignmentPairService {
  constructor(
    private readonly repo: ReadingAlignmentRepository,
    @Optional() private readonly editionSyncFallback?: EditionSyncFallbackService,
  ) {}

  // A book with a read-along syncs its text and audio through upstream's read-aloud sync, so it has
  // no whisper pair. With edition sync installed, a pair exists only for a failed-index book, for a
  // user whose edition sync (permission, enabled, scope) and read-aloud sync mode allow it.
  async resolveAlignmentPair(bookId: number, userId: number): Promise<ReadingAlignmentPair | null> {
    const [ebook, audio, readAlong] = await Promise.all([
      this.repo.findEbookFile(bookId),
      this.repo.resolveAudioPlayOrder(bookId),
      this.repo.hasReadAlong(bookId),
    ]);
    if (!ebook || audio.length === 0 || readAlong) return null;
    if (this.editionSyncFallback && !(await this.editionSyncFallback.allowsWhisperFallback(userId, bookId))) return null;
    if ((await this.repo.findReadAloudSyncMode(userId, bookId)) === 'disabled') return null;
    return { textBookId: bookId, audioBookId: bookId };
  }
}
