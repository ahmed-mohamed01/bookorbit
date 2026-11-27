import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AiConnectionService } from '../../ai/ai-connection.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiJobsService } from '../../ai-jobs/ai-jobs.service';
import { AiStepRates } from '../../ai-jobs/ai-step-rates.service';
import { STORY_GUIDE_PIPELINE } from '../../story-guides/pipeline/story-guide-pipeline';
import { BookService } from '../../book/book.service';
import { StoryGuideEstimator } from '../../story-guides/story-guide-estimator.service';
import { StoryGuideFeature } from '../../story-guides/story-guide.feature';
import { StoryGuidesRepository } from '../../story-guides/story-guides.repository';
import { StoryTextService } from '../../story-guides/story-text.service';
import { BkStoryGuideEstimator } from './bk-story-guide-estimator';
import { BkStoryGuideFeature } from './bk-story-guide-feature';
import { bkStoryGuidePipelineProviders } from './bk-story-guide-pipeline.module';
import { BkStoryGuideRunner } from './bk-story-guide-runner.service';

describe('bkStoryGuidePipelineProviders', () => {
  it("replaces upstream's estimator, pipeline and feature when listed after them", async () => {
    const stub = (token: abstract new (...args: never[]) => unknown) => ({ provide: token, useValue: {} });
    const module = await Test.createTestingModule({
      providers: [
        stub(AiSettingsService),
        stub(AiConnectionService),
        stub(AiStepRates),
        stub(StoryTextService),
        stub(BkStoryGuideRunner),
        stub(AiJobsService),
        stub(StoryGuidesRepository),
        stub(BookService),
        StoryGuideEstimator,
        { provide: STORY_GUIDE_PIPELINE, useValue: { steps: [{ id: 'names' }], assembleVersion: 1 } },
        StoryGuideFeature,
        ...bkStoryGuidePipelineProviders,
      ],
    }).compile();

    expect(module.get(StoryGuideEstimator)).toBeInstanceOf(BkStoryGuideEstimator);
    expect(module.get(STORY_GUIDE_PIPELINE).steps[0].id).toBe('bk');
    expect(module.get(StoryGuideFeature)).toBeInstanceOf(BkStoryGuideFeature);
    expect(module.get(StoryGuideFeature).steps[0].id).toBe('bk');
  });
});
