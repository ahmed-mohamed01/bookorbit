import { Injectable } from '@nestjs/common';

import type { ReadAlongProvenanceSource } from '../book/read-along-provenance-source';
import type {
  ReadAlongAttachment,
  ReadAlongBuildProposal,
  ReadAlongBuildRef,
  ReadAlongLinkTarget,
  ReadAlongOutputSource,
  ReadAlongSourcePair,
} from '../edition-link/read-along-output-source';
import { isLostReadAlongMember } from './read-along-attachment';
import type { StorytellerReadAlongBuild } from './schema/storyteller.schema';
import { StorytellerRepository } from './storyteller.repository';

function toProposal(build: StorytellerReadAlongBuild | undefined): ReadAlongBuildProposal | null {
  return build ? { textBookId: build.textBookId, audioBookId: build.audioBookId, status: build.status, outputBookId: build.outputBookId } : null;
}

@Injectable()
export class StorytellerReadAlongOutputService implements ReadAlongOutputSource, ReadAlongProvenanceSource {
  constructor(private readonly repo: StorytellerRepository) {}

  findReadAlongOutputs(bookIds: readonly number[]): Promise<Set<number>> {
    if (bookIds.length === 0) return Promise.resolve(new Set());
    return this.repo.findOutputBookIds(bookIds);
  }

  async findSourcePair(readAlongBookId: number): Promise<ReadAlongSourcePair | null> {
    const build = await this.repo.findBuildByOutputBook(readAlongBookId);
    return build ? { textBookId: build.textBookId, audioBookId: build.audioBookId } : null;
  }

  async findSourceAudioBookId(readAlongBookId: number): Promise<number | null> {
    return (await this.findSourcePair(readAlongBookId))?.audioBookId ?? null;
  }

  async findBuildByReadAlong(readAlongBookId: number): Promise<ReadAlongBuildRef | null> {
    const build = await this.repo.findBuildByOutputBook(readAlongBookId);
    if (!build || build.status !== 'ready' || build.outputBookId === null) return null;
    return { buildId: build.id, outputBookId: build.outputBookId, textBookId: build.textBookId, audioBookId: build.audioBookId };
  }

  async findNewestBuildForText(textBookId: number): Promise<ReadAlongBuildProposal | null> {
    return toProposal(await this.repo.findNewestBuildForText(textBookId));
  }

  async findNewestBuildForAudio(audioBookId: number): Promise<ReadAlongBuildProposal | null> {
    return toProposal(await this.repo.findNewestBuildForAudio(audioBookId));
  }

  async findLostReadAlong(link: ReadAlongLinkTarget): Promise<ReadAlongAttachment | null> {
    if (link.readAlongBookId !== null || link.textBookId === null) return null;
    const build = await this.repo.findBuildByPair(link.textBookId, link.audioBookId);
    // The output's foreign key nulls it when the book is deleted, so a set id is a book that exists.
    if (!build || build.status !== 'ready' || build.outputBookId === null) return null;
    if (!isLostReadAlongMember(link, build.attachedLinkId)) return null;
    return { buildId: build.id, outputBookId: build.outputBookId };
  }

  async recordAttachment(buildId: number, linkId: number): Promise<void> {
    await this.repo.updateBuild(buildId, { attachedLinkId: linkId });
  }

  async recordDetach(readAlongBookId: number, linkId: number): Promise<void> {
    const build = await this.repo.findBuildByOutputBook(readAlongBookId);
    if (build) await this.repo.updateBuild(build.id, { attachedLinkId: linkId });
  }
}
