import type { AiJobEstimate, AiJobModels } from '@bookorbit/types';

import { STORY_GUIDE_STEP_COSTS } from '../../story-guides/story-guide-estimate';
import { StoryGuideEstimator, type StoryGuideRunProgress } from '../../story-guides/story-guide-estimator.service';
import type { StoryTextService } from '../../story-guides/story-text.service';
import type { BkStoryGuideRunner } from './bk-story-guide-runner.service';

/**
 * Applied to upstream's estimate (its fast-slot steps, as BK runs on Fast only) for the same text while the index is not ready. Measured on
 * The Calamitous Bob, 91,485 words, DeepSeek-V4-Flash at $0.06 in / $0.18 out per million tokens: upstream gives
 * $0.121 to $0.133 (24 chapters to 35 spine sections, words split evenly since the split is unknown; $0.0995 as
 * one section), the BK dry run $0.0967 (0.73 to 0.80 of upstream) and the real build $0.0824 (0.62 to 0.68).
 * At 1 the quote stays above the real cost and the 3x over-estimate pause stays far from it.
 */
export const BK_ESTIMATE_FALLBACK_FACTOR = 1;

const UPSTREAM_STEPS = Object.entries(STORY_GUIDE_STEP_COSTS)
  .filter(([, cost]) => cost.slot === 'fast')
  .map(([step]) => step);

type Text = Parameters<StoryGuideEstimator['estimate']>[0] & { fileId: number };

/**
 * Prices the `bk` step, which has no entry in upstream's step costs: the card and the job's estimate
 * would otherwise read 0 minutes and $0. Other steps are priced by upstream.
 */
export class BkStoryGuideEstimator extends StoryGuideEstimator {
  constructor(
    deps: ConstructorParameters<typeof StoryGuideEstimator>,
    private readonly texts: Pick<StoryTextService, 'file'>,
    private readonly runner: Pick<BkStoryGuideRunner, 'estimate' | 'minutesLeft'>,
  ) {
    super(...deps);
  }

  override async estimate(text: Text, steps: readonly string[], models: AiJobModels): Promise<AiJobEstimate> {
    if (!steps.includes('bk')) return super.estimate(text, steps, models);
    const file = await this.texts.file(text.fileId);
    const planned = file ? await this.runner.estimate(file.bookId, text) : null;
    if (planned) return planned;
    const upstream = await super.estimate(text, UPSTREAM_STEPS, models);
    return {
      words: upstream.words,
      minutes: upstream.minutes === null ? null : Math.ceil(upstream.minutes * BK_ESTIMATE_FALLBACK_FACTOR),
      cost: upstream.cost === null ? null : Math.round(upstream.cost * BK_ESTIMATE_FALLBACK_FACTOR * 10_000) / 10_000,
    };
  }

  /** Upstream's step rates cannot time a BK build; the running build times its own description chunks. */
  override async minutesLeft(text: Text, steps: readonly string[], models: AiJobModels, progress: StoryGuideRunProgress): Promise<number | null> {
    if (!progress.order.includes('bk')) return super.minutesLeft(text, steps, models, progress);
    if (progress.phase !== 'lines') return null;
    const file = await this.texts.file(text.fileId);
    return file ? this.runner.minutesLeft(file.bookId) : null;
  }
}
