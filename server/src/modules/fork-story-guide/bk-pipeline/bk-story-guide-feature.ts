import type { AiRefusal } from '../../ai-jobs/ai-feature';
import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { StoryGuideFeature } from '../../story-guides/story-guide.feature';
import type { BkStoryGuideRunner } from './bk-story-guide-runner.service';

declare module '../../story-guides/story-guide.feature' {
  interface StoryGuideFeature {
    /** Fork hook read by the status: false offers no Build and gives the reason `off`. */
    buildable?(): Promise<boolean>;
  }
}

/**
 * Refuses a story guide job while Book Knowledge is off, or for a file BK does not build from, so the engine
 * never creates or retries a job the runner would fail. Everything else is upstream's check.
 */
export class BkStoryGuideFeature extends StoryGuideFeature {
  constructor(
    deps: ConstructorParameters<typeof StoryGuideFeature>,
    private readonly runner: Pick<BkStoryGuideRunner, 'enabled' | 'sourceFileId'>,
  ) {
    super(...deps);
  }

  override async check(subject: StoryGuideSubject): Promise<AiRefusal | null> {
    if (!(await this.runner.enabled())) return { reason: 'off' };
    if ((await this.runner.sourceFileId(subject.bookId)) !== subject.file.id) return { reason: 'unreadable' };
    return super.check(subject);
  }

  override buildable(): Promise<boolean> {
    return this.runner.enabled();
  }

  /** The engine sees one `bk` unit; the payload carries Book Knowledge's own answered share. */
  coverageOf(artifact: unknown): number {
    const coverage = (artifact as { coverage?: unknown } | null)?.coverage;
    return typeof coverage === 'number' && Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : 1;
  }
}
