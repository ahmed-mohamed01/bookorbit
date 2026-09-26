import { Injectable } from '@nestjs/common';

import { EditionLinkRepository } from '../edition-link/edition-link.repository';

export interface ReadingAlignmentPair {
  textBookId: number;
  audioBookId: number;
}

@Injectable()
export class ReadingAlignmentPairService {
  constructor(private readonly editionLinkRepo: EditionLinkRepository) {}

  async resolveAlignmentPair(bookId: number): Promise<ReadingAlignmentPair | null> {
    const link = await this.editionLinkRepo.findLinkForBook(bookId);
    if (link) {
      // The generated read-along is its own book record with its own progress, so neither the sampled
      // alignment nor cross-format resume may run on it: it is not a side of the pair, and treating it
      // as one would project the pair's positions onto a third, unrelated file.
      if (link.readAlongBookId === bookId) return null;
      return { textBookId: link.textBookId, audioBookId: link.audioBookId };
    }

    const modality = await this.editionLinkRepo.getBookModality(bookId);
    if (modality === 'both') {
      return { textBookId: bookId, audioBookId: bookId };
    }

    return null;
  }
}
