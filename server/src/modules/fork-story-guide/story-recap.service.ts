import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { READING_HELP_ERROR_CODES, type ReadingHelpRequest, type ForkStoryGuidePayload, type ForkStoryRecap } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EpubDomService } from '../position-converter/epub-dom.service';
import { ReadingHelpService } from '../reading-help/reading-help.service';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { bkGuideContent } from './bk-pipeline/rewrite-bk-extras';
import { buildStoryGuideCut, pickStretch, placeCfi, visibleSummaries } from './story-recap.core';

type RecapMetrics = { chapterIndex: number | null; stretchChars: number };

/** The nearest titled section at or before [index]: an untitled section continues the chapter before it. */
function chapterTitleAt(titles: Map<number, string | null>, index: number): string | null {
  for (let s = index; s >= 0; s--) {
    const title = titles.get(s)?.trim();
    if (title) return title;
  }
  return null;
}

@Injectable()
export class StoryRecapService {
  private readonly logger = new Logger(StoryRecapService.name);

  constructor(
    private readonly books: BookService,
    private readonly guides: StoryGuidesService,
    private readonly epubDom: EpubDomService,
    private readonly readingHelp: ReadingHelpService,
  ) {}

  async recap(
    fileId: number,
    user: RequestUser,
    includeStop: boolean,
    acceptLanguage: string | undefined,
    signal: AbortSignal,
  ): Promise<ForkStoryRecap> {
    const startedAt = Date.now();
    const context = `fileId=${fileId} userId=${user.id}`;
    const metrics: RecapMetrics = { chapterIndex: null, stretchChars: 0 };
    // The stop=0 read is a cheap poll on every progress event, so only the Reading help call logs start and end.
    if (includeStop) this.logger.log(`[story_guide.recap] [start] ${context} includeStop=${includeStop} - story recap started`);

    const outcome = (stopState: string, cached = false) =>
      `${context} includeStop=${includeStop} durationMs=${Date.now() - startedAt} chapterIndex=${metrics.chapterIndex} stretchChars=${metrics.stretchChars} cached=${cached} stopState=${stopState}`;

    try {
      const result = await this.buildRecap(fileId, user, includeStop, acceptLanguage, signal, metrics);
      const { stop } = result;
      if (stop.state === 'failed') {
        this.logger.warn(
          `[story_guide.recap] [fail] ${outcome(stop.state)} errorClass=ReadingHelp error="${sanitizeLogValue(stop.code ?? 'Reading help did not complete')}" - story recap answer failed`,
        );
      } else if (includeStop) {
        this.logger.log(`[story_guide.recap] [end] ${outcome(stop.state, stop.state === 'ok' && stop.cached)} - story recap completed`);
      }
      return result;
    } catch (error) {
      const errorClass = error instanceof Error ? sanitizeLogValue(error.name) : 'Error';
      this.logger.warn(
        `[story_guide.recap] [fail] ${outcome('failed')} errorClass=${errorClass} error="Story recap unavailable" - story recap failed`,
      );
      throw error;
    }
  }

  private async buildRecap(
    fileId: number,
    user: RequestUser,
    includeStop: boolean,
    acceptLanguage: string | undefined,
    signal: AbortSignal,
    metrics: RecapMetrics,
  ): Promise<ForkStoryRecap> {
    const progress = await this.books.getProgress(user.id, fileId, user);
    if (!progress?.cfi) {
      return { state: 'no-position', cut: null, previously: [], stop: { state: 'skipped' } };
    }

    const { cfi, percentage } = progress;
    let text = '';
    const placed = await placeCfi(cfi, async (index) => {
      metrics.chapterIndex = index;
      const doc = await this.epubDom.getChapter(fileId, index);
      text = doc?.index.collapsed ?? '';
      return doc;
    });
    const defaultStop = { state: includeStop ? 'unplaced' : 'skipped' } as const;
    if (!placed) return { state: 'ok', cut: null, previously: [], stop: defaultStop };

    const { chapterIndex, offset } = placed;
    const content = await bkGuideContent(this.guides, fileId, [1], user);
    const guide = content.kind === 'found' ? (content.body as ForkStoryGuidePayload) : undefined;
    const titles = new Map(guide?.sections.map(({ s, title }) => [s, title]));
    const titleOf = (index: number) => titles.get(index) ?? null;
    const position = { chapterIndex, percentage, cfi, chapterTitle: chapterTitleAt(titles, chapterIndex) };
    const placement = { chapterIndex, offset, text };
    const cut = buildStoryGuideCut(guide, placement);
    const previously = visibleSummaries(guide?.summaries ?? [], placement, titleOf);
    if (!includeStop || offset === null) return { state: 'ok', position, cut, previously, stop: defaultStop };

    const stretch = await pickStretch(
      async (index) => {
        if (signal.aborted) return null;
        if (index === chapterIndex) return text;
        return (await this.epubDom.getChapter(fileId, index))?.index.collapsed ?? null;
      },
      { chapterIndex, offset },
    );
    if (signal.aborted) return { state: 'ok', position, cut, previously, stop: { state: 'skipped' } };
    if (!stretch) return { state: 'ok', position, cut, previously, stop: defaultStop };

    metrics.stretchChars = stretch.length;
    const language = guide?.language || acceptLanguage?.split(/[,;]/u, 1)[0]?.trim() || 'en';
    const stop = await this.answerStop(user, { kind: 'recap-stop', fileId, language, passages: [stretch] }, signal);
    return { state: 'ok', position, cut, previously, stop };
  }

  private async answerStop(user: RequestUser, request: ReadingHelpRequest, signal: AbortSignal): Promise<ForkStoryRecap['stop']> {
    try {
      const events = await this.readingHelp.answer(user, request, signal);
      for await (const event of events) {
        if (signal.aborted) break;
        if (event.type === 'done') return { state: 'ok', text: event.text, cached: event.cached };
        if (event.type === 'error') return { state: 'failed', code: event.errorCode };
      }
    } catch (error) {
      const body = error instanceof HttpException ? error.getResponse() : undefined;
      if (body && typeof body === 'object' && 'errorCode' in body) {
        const code = READING_HELP_ERROR_CODES.find((value) => value === body.errorCode);
        switch (code) {
          case 'READING_HELP_OFF':
            return { state: 'off', code };
          case 'READING_HELP_BUDGET':
            return { state: 'budget', code };
          case 'READING_HELP_READER_CAP':
            return { state: 'cap', code };
          default:
            if (code) return { state: 'failed', code };
        }
      }
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
    }
    return { state: 'failed' };
  }
}
