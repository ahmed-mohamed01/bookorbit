import { Injectable } from '@nestjs/common';

import { ReadingAlignmentRepository } from './reading-alignment.repository';

export interface ReadingAlignmentPair {
  textBookId: number;
  audioBookId: number;
}

@Injectable()
export class ReadingAlignmentPairService {
  constructor(private readonly repo: ReadingAlignmentRepository) {}

  // A book with a read-along syncs its text and audio through upstream's read-aloud sync, so it has
  // no whisper pair: nothing builds, resolves or projects an alignment for it.
  async resolveAlignmentPair(bookId: number): Promise<ReadingAlignmentPair | null> {
    const [ebook, audio, readAlong] = await Promise.all([
      this.repo.findEbookFile(bookId),
      this.repo.resolveAudioPlayOrder(bookId),
      this.repo.hasReadAlong(bookId),
    ]);
    return ebook && audio.length > 0 && !readAlong ? { textBookId: bookId, audioBookId: bookId } : null;
  }
}
