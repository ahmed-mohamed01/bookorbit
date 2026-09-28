import { Injectable } from '@nestjs/common';

import type { ReadAlongOutputSource } from '../edition-link/read-along-output-source';
import { StorytellerRepository } from './storyteller.repository';

@Injectable()
export class StorytellerReadAlongOutputService implements ReadAlongOutputSource {
  constructor(private readonly repo: StorytellerRepository) {}

  findReadAlongOutputs(bookIds: readonly number[]): Promise<Set<number>> {
    if (bookIds.length === 0) return Promise.resolve(new Set());
    return this.repo.findOutputBookIds(bookIds);
  }
}
