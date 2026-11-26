import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Permission, type AiJobEstimate, type AiJobSlotModel, type BookKnowledgeXrayEstimate, type BookKnowledgeXrayPayload } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { AiClient } from '../../ai/ai-client.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import type { AiResult, AiSlotChoice } from '../../ai/ai-client.types';
import { AiJobFailure, AiJobPause, AiUnitSkipped, type AiStepContext } from '../../ai-jobs/ai-feature';
import { AI_JOBS_MIN_COVERAGE } from '../../ai-jobs/ai-jobs.constants';
import { BookKnowledgeService } from '../../book-knowledge/book-knowledge.service';
import { BOOK_KNOWLEDGE_AI_FEATURE, bookKnowledgeTuning } from '../../book-knowledge/book-knowledge-model.service';
import { BookKnowledgeXrayService, type XrayCompleter } from '../../book-knowledge/book-knowledge-xray.service';
import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { BkStoryGuideProgress } from './bk-story-guide-progress';

export const BK_INDEX_POLL_MS = 5_000;
export const BK_INDEX_TIMEOUT_MS = 45 * 60_000;
const PLAN_CACHE_SIZE = 32;
/** A plan that failed (no BK model, say) is not retried by every status poll for this long. */
export const BK_PLAN_FAILURE_TTL_MS = 3 * 60_000;

type KeptPlan = { plan: Promise<BookKnowledgeXrayEstimate>; failedAt: number | null };

/**
 * The engine hands a step neither a user nor the requester, and it has already checked the requester's
 * access before each step, so Book Knowledge is read as a system actor that only passes its book gate.
 */
const SYSTEM_ACTOR: RequestUser = {
  id: 0,
  username: 'story-guide-job',
  name: 'Story guide job',
  email: null,
  active: true,
  isSuperuser: true,
  isDefaultPassword: false,
  tokenVersion: 0,
  settings: {},
  avatarUrl: null,
  provisioningMethod: 'system',
  permissions: [Permission.LibraryGenerateStoryGuide],
  contentFilters: {},
} as RequestUser;

const SKIPPED_FINISH: Record<AiUnitSkipped['reason'], AiResult['finish']> = {
  refused: 'refused',
  filtered: 'filtered',
  'too-long': 'length',
  'invalid-json': 'refused',
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs Book Knowledge's build as the story guide's one step, and prices it. */
@Injectable()
export class BkStoryGuideRunner {
  private readonly logger = new Logger(BkStoryGuideRunner.name);
  private readonly plans = new Map<string, KeptPlan>();
  private readonly progress = new Map<number, BkStoryGuideProgress>();

  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly xray: BookKnowledgeXrayService,
    private readonly aiSettings: AiSettingsService,
    private readonly client: AiClient,
  ) {}

  async build(ctx: AiStepContext<StoryGuideSubject>): Promise<BookKnowledgeXrayPayload> {
    const { bookId } = ctx.subject;
    const started = Date.now();
    const ids = `jobId=${ctx.job.id} bookId=${bookId}`;
    const progress = new BkStoryGuideProgress(ctx.progress?.bind(ctx));
    this.progress.set(bookId, progress);
    this.logger.log(`[story_guide.bk_build] [start] ${ids} - Book Knowledge build started`);
    try {
      progress.index(undefined);
      // Checked again here for jobs queued before Book Knowledge was switched off or its file changed.
      if ((await this.knowledge.sourceFileId(bookId)) !== ctx.subject.file.id) {
        throw new AiJobFailure('unreadable', "Book Knowledge builds the guide for the book's main ebook file");
      }
      if (!(await this.aiFeatureOn())) throw new AiJobFailure('unreadable', 'Book Knowledge is off');
      await this.ensureIndex(bookId, ctx.signal, progress);
      const use = await this.choiceFor(ctx.job.models.fast);
      const payload = await this.xray.buildForStoryGuide({
        bookId,
        fileId: ctx.subject.file.id,
        user: SYSTEM_ACTOR,
        complete: this.completer(ctx),
        signal: ctx.signal,
        use,
        // Rebuild starts a new generation, which must ask the model again; Continue, Retry and Update replay.
        replayScope: String(ctx.job.generation),
        onProgress: progress.stage,
      });
      await progress.settled();
      // Upstream's coverage floor sees one unit here, so the units Book Knowledge skipped are checked instead.
      if (payload.coverage < AI_JOBS_MIN_COVERAGE) {
        throw new AiJobFailure('low-coverage', `Book Knowledge answered ${Math.round(payload.coverage * 100)}% of a step's units`);
      }
      this.logger.log(
        `[story_guide.bk_build] [end] ${ids} durationMs=${Date.now() - started} outcome=completed entities=${payload.entities.length} - Book Knowledge build completed`,
      );
      return payload;
    } catch (error) {
      await progress.settled();
      const stopped = error instanceof AiJobPause ? 'paused' : ctx.signal.aborted ? 'cancelled' : null;
      if (stopped) {
        this.logger.log(`[story_guide.bk_build] [end] ${ids} durationMs=${Date.now() - started} outcome=${stopped} - Book Knowledge build stopped`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[story_guide.bk_build] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(message.slice(0, 200))}" - Book Knowledge build failed`,
        );
      }
      throw error;
    } finally {
      if (this.progress.get(bookId) === progress) this.progress.delete(bookId);
    }
  }

  /** Whether Book Knowledge can build: its own switch and its AI feature row. */
  async enabled(): Promise<boolean> {
    const [on, feature] = await Promise.all([this.knowledge.enabled(), this.aiFeatureOn()]);
    return on && feature;
  }

  sourceFileId(bookId: number): Promise<number | null> {
    return this.knowledge.sourceFileId(bookId);
  }

  /** Minutes the running build of this book has left, measured from its recent chunks; null when unknown. */
  minutesLeft(bookId: number): number | null {
    return this.progress.get(bookId)?.minutesLeft() ?? null;
  }

  /** The dry-run price of the build from the ready index, or null while there is none or it cannot be planned. */
  async estimate(bookId: number, text: { sections: readonly { words: number }[] }): Promise<AiJobEstimate | null> {
    const started = Date.now();
    try {
      // A read-only peek: a status view must not queue an index build or read a book upstream's would not.
      const peeked = await this.knowledge.peek(bookId);
      if (!peeked) return null;
      const kept = this.plan(`${bookId}:${peeked.fingerprint}`, bookId);
      let plan: BookKnowledgeXrayEstimate;
      try {
        plan = await kept.plan;
      } catch (error) {
        if (kept.failedAt !== null) return null;
        throw error;
      }
      const slots = await this.aiSettings.slots();
      return this.priced(text, plan, slots.fast.prices);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[story_guide.bk_estimate] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(message.slice(0, 200))}" - dry-run estimate failed`,
      );
      return null;
    }
  }

  /**
   * The dry run reads the whole book, and status views ask often, so a plan is kept per index. A failed one
   * is kept briefly and reported as already failed, so a poll neither retries nor logs it again.
   */
  private plan(key: string, bookId: number): KeptPlan {
    const kept = this.plans.get(key);
    if (kept && (kept.failedAt === null || Date.now() - kept.failedAt < BK_PLAN_FAILURE_TTL_MS)) {
      this.plans.delete(key);
      this.plans.set(key, kept);
      return kept.failedAt === null ? { plan: kept.plan, failedAt: null } : kept;
    }
    const entry: KeptPlan = { plan: this.xray.planEstimate(bookId, SYSTEM_ACTOR), failedAt: null };
    entry.plan.catch(() => {
      if (this.plans.get(key) === entry) entry.failedAt = Date.now();
    });
    this.plans.set(key, entry);
    while (this.plans.size > PLAN_CACHE_SIZE) this.plans.delete(this.plans.keys().next().value!);
    return { plan: entry.plan, failedAt: null };
  }

  /** The job's recorded model, with the slot's current terms while it still names the same one. */
  private async choiceFor(recorded: AiJobSlotModel | undefined): Promise<AiSlotChoice> {
    if (!recorded) throw new AiJobFailure('error', 'The job recorded no model for the fast slot');
    const current = await this.client.resolveSlot('fast').catch(() => null);
    if (current && current.connectionId === recorded.connectionId && current.model === recorded.model) return { ...current, effort: recorded.effort };
    return { slot: 'fast', connectionId: recorded.connectionId, model: recorded.model, prices: null, jsonMode: 'auto', effort: recorded.effort };
  }

  private priced(
    text: { sections: readonly { words: number }[] },
    plan: BookKnowledgeXrayEstimate,
    prices: { input: number; output: number } | null,
  ): AiJobEstimate {
    const words = text.sections.reduce((total, section) => total + section.words, 0);
    const cost = prices ? Math.round(((plan.promptTokens * prices.input + plan.outputTokens * prices.output) / 1_000_000) * 10_000) / 10_000 : null;
    // The plan's minutes are a local-model rate, far too slow for a hosted model, so none is claimed until a build has measured one.
    return { words, minutes: null, cost };
  }

  private async aiFeatureOn(): Promise<boolean> {
    return (await this.aiSettings.features())[BOOK_KNOWLEDGE_AI_FEATURE]?.enabled === true;
  }

  /**
   * The engine swaps `use` for the job's model, and a pause cannot recall calls already in flight: they
   * run to the end and are dropped. The cap rides on maxOutputTokens since the request carries no slot limit;
   * an ask cut short at the cap is retried once at double the output by the engine's client (cost only, within the cap).
   */
  private completer(ctx: AiStepContext<StoryGuideSubject>): XrayCompleter {
    return async ({ use, ...request }) => {
      try {
        return await ctx.complete({ ...request, ...bookKnowledgeTuning(use.model, request) });
      } catch (error) {
        if (error instanceof AiUnitSkipped) {
          return { text: '', usage: { input: 0, output: 0 }, finish: SKIPPED_FINISH[error.reason], model: use.model };
        }
        throw error;
      }
    };
  }

  private async ensureIndex(bookId: number, signal: AbortSignal, progress: BkStoryGuideProgress): Promise<void> {
    const deadline = Date.now() + BK_INDEX_TIMEOUT_MS;
    let started = false;
    for (;;) {
      signal.throwIfAborted();
      const { artifact, row, enabled, queued } = await this.knowledge.context(bookId, SYSTEM_ACTOR, 'full', false).catch((error: unknown) => {
        if (error instanceof BadRequestException) throw new AiJobFailure('unreadable', error.message);
        throw error;
      });
      progress.index(row?.status);
      if (!enabled) throw new AiJobFailure('unreadable', 'Book Knowledge is off');
      if (artifact && row?.status === 'ready') return;
      // context() queues only a stale row, so a book with no index row or a failed one is queued here, once.
      if ((!row || row.status === 'failed') && !queued && !started) {
        started = true;
        await this.knowledge.build(bookId, SYSTEM_ACTOR, 'full');
        continue;
      }
      if (row?.status === 'failed' && !queued) throw new AiJobFailure('unreadable', 'Book Knowledge could not index this book');
      if (Date.now() >= deadline) throw new AiJobFailure('error', 'Book Knowledge index timed out');
      await sleep(BK_INDEX_POLL_MS, signal);
    }
  }
}
