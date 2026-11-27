import { STORY_GUIDE_FEATURE, type AiJobEstimate, type AiJobModels } from '@bookorbit/types';

import { STORY_GUIDE_STEP_COSTS } from '../../story-guides/story-guide-estimate';
import { StoryGuideEstimator, type StoryGuideRunProgress } from '../../story-guides/story-guide-estimator.service';
import type { AiJobsService } from '../../ai-jobs/ai-jobs.service';
import type { StoryTextService } from '../../story-guides/story-text.service';
import type { BkStoryGuideRunner } from './bk-story-guide-runner.service';

/**
 * Applied to upstream's estimate (its fast-slot steps, as BK runs on Fast only) for a text with no guide yet. Measured on
 * The Calamitous Bob, 91,485 words, DeepSeek-V4-Flash at $0.06 in / $0.18 out per million tokens: upstream gives
 * $0.121 to $0.133 (24 chapters to 35 spine sections, words split evenly since the split is unknown; $0.0995 as
 * one section) and the real build $0.0824 (0.62 to 0.68). At 1 the quote stays above the real cost and the 3x
 * over-estimate pause stays far from it.
 */
export const BK_ESTIMATE_FALLBACK_FACTOR = 1;

const UPSTREAM_STEPS = Object.entries(STORY_GUIDE_STEP_COSTS)
  .filter(([, cost]) => cost.slot === 'fast')
  .map(([step]) => step);

type Text = Parameters<StoryGuideEstimator['estimate']>[0] & { fileId: number; textKey?: string | null };

/**
 * Prices the `bk` step, which has no entry in upstream's step costs: the card and the job's estimate
 * would otherwise read 0 minutes and $0. A text with a guide is quoted what its last build spent on the same
 * model; any other by upstream's estimate. Other steps are priced by upstream.
 */
export class BkStoryGuideEstimator extends StoryGuideEstimator {
  constructor(
    deps: ConstructorParameters<typeof StoryGuideEstimator>,
    private readonly texts: Pick<StoryTextService, 'file'>,
    private readonly runner: Pick<BkStoryGuideRunner, 'minutesLeft'>,
    private readonly jobs: Pick<AiJobsService, 'artifactInfo'>,
  ) {
    super(...deps);
  }

  override async estimate(text: Text, steps: readonly string[], models: AiJobModels): Promise<AiJobEstimate> {
    if (!steps.includes('bk')) return super.estimate(text, steps, models);
    const upstream = await super.estimate(text, UPSTREAM_STEPS, models);
    const spent = await this.lastSpent(text.textKey, models);
    return {
      words: upstream.words,
      minutes: upstream.minutes === null ? null : Math.ceil(upstream.minutes * BK_ESTIMATE_FALLBACK_FACTOR),
      cost: spent ?? (upstream.cost === null ? null : Math.round(upstream.cost * BK_ESTIMATE_FALLBACK_FACTOR * 10_000) / 10_000),
    };
  }

  /** What the text's last build spent, in dollars, while the Fast slot still names the model it ran on. */
  private async lastSpent(textKey: string | null | undefined, models: AiJobModels): Promise<number | null> {
    if (!textKey) return null;
    const artifact = await this.jobs.artifactInfo(STORY_GUIDE_FEATURE, textKey);
    const built = artifact?.models?.fast;
    const now = models.fast;
    if (!artifact?.costMicros || !built || !now || built.connectionId !== now.connectionId || built.model !== now.model) return null;
    return Math.round(artifact.costMicros / 100) / 10_000;
  }

  /** Upstream's step rates cannot time a BK build; the running build times its own description chunks. */
  override async minutesLeft(text: Text, steps: readonly string[], models: AiJobModels, progress: StoryGuideRunProgress): Promise<number | null> {
    if (!progress.order.includes('bk')) return super.minutesLeft(text, steps, models, progress);
    if (progress.phase !== 'lines') return null;
    const file = await this.texts.file(text.fileId);
    return file ? this.runner.minutesLeft(file.bookId) : null;
  }
}
