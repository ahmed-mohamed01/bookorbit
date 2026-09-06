import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '../../config/config';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { describeError } from './reading-alignment-error.util';
import { BookService } from '../book/book.service';
import { ReadingAlignmentBuildService } from './reading-alignment-build.service';
import type { ReadingAlignmentPair } from './reading-alignment-pair.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { WhisperService } from './whisper.service';

const REQUEST_EVENT = 'reading_alignment.request_build';

export type AlignmentBuildRequestResult = { status: string };
export type AlignmentStatusResult =
  { status: 'none' } | { status: string; samplesDone: number; samplesTotal: number | null; anchorCount: number; builtAt: Date | null };

@Injectable()
export class ReadingAlignmentStatusService {
  private readonly logger = new Logger(ReadingAlignmentStatusService.name);

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    private readonly repo: ReadingAlignmentRepository,
    private readonly buildService: ReadingAlignmentBuildService,
    private readonly whisper: WhisperService,
    private readonly bookService: BookService,
    private readonly pairService: ReadingAlignmentPairService,
  ) {}

  // Kicks off a build WITHOUT awaiting it (a build can run for minutes) and reports the status the UI
  // should show right now: the existing row's status when one exists, or 'building' for a fresh kickoff.
  // The build service owns an in-flight guard, so a repeated request never starts a duplicate build.
  async requestBuild(bookId: number, user: RequestUser, force = false): Promise<AlignmentBuildRequestResult> {
    await this.assertAccess(bookId, user);
    const pair = await this.pairService.resolveAlignmentPair(bookId);
    if (!pair) return { status: 'none' };
    await this.assertPairAccess(pair, bookId, user);

    // Report the real reason a build cannot start instead of a "building" spinner that never resolves.
    if (!this.config.readingAlignmentEnabled) return { status: 'disabled' };
    if (!this.whisper.isAvailable()) return { status: 'unavailable' };

    const existing = await this.repo.getAlignmentByPair(pair.textBookId, pair.audioBookId);
    const alreadyBuilding = existing?.status === 'building';
    if (!alreadyBuilding && this.buildService.isAtCapacity()) {
      this.logger.log(
        `[${REQUEST_EVENT}] [end] bookId=${bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} userId=${user.id} status=busy - build capacity reached`,
      );
      return { status: 'busy' };
    }

    void this.buildService.buildAlignment(bookId, user, force).catch((error: unknown) => {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${REQUEST_EVENT}] [fail] bookId=${bookId} userId=${user.id} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - background build failed`,
      );
    });

    const status = existing?.status ?? 'building';
    this.logger.log(
      `[${REQUEST_EVENT}] [end] bookId=${bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} userId=${user.id} status=${status} force=${force} - build requested`,
    );
    return { status };
  }

  async getStatus(bookId: number, user: RequestUser): Promise<AlignmentStatusResult> {
    await this.assertAccess(bookId, user);
    const pair = await this.pairService.resolveAlignmentPair(bookId);
    if (!pair) return { status: 'none' };
    await this.assertPairAccess(pair, bookId, user);

    const alignment = await this.repo.getAlignmentByPair(pair.textBookId, pair.audioBookId);
    if (!alignment) return { status: 'none' };

    return {
      status: alignment.status,
      samplesDone: alignment.samplesDone,
      samplesTotal: alignment.samplesTotal,
      anchorCount: alignment.anchorCount,
      builtAt: alignment.builtAt,
    };
  }

  private async assertAccess(bookId: number, user: RequestUser): Promise<void> {
    // Content-filter aware access check (see resolve service) so build/status cannot be probed for a
    // book hidden from the user.
    await this.bookService.verifyBookAccess(bookId, user);
  }

  private async assertPairAccess(pair: ReadingAlignmentPair, requestedBookId: number, user: RequestUser): Promise<void> {
    const counterpartIds = new Set([pair.textBookId, pair.audioBookId]);
    counterpartIds.delete(requestedBookId);
    await Promise.all([...counterpartIds].map((bookId) => this.assertAccess(bookId, user)));
  }
}
