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
      return { textBookId: link.textBookId, audioBookId: link.audioBookId };
    }

    const modality = await this.editionLinkRepo.getBookModality(bookId);
    if (modality === 'both') {
      return { textBookId: bookId, audioBookId: bookId };
    }

    return null;
  }
}
