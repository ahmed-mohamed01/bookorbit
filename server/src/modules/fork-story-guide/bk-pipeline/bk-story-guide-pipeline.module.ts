import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { BookKnowledgeModule } from '../../book-knowledge/book-knowledge.module';
import { AiConnectionService } from '../../ai/ai-connection.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiJobsService } from '../../ai-jobs/ai-jobs.service';
import { AiStepRates } from '../../ai-jobs/ai-step-rates.service';
import { STORY_GUIDE_PIPELINE, type StoryGuidePipeline } from '../../story-guides/pipeline/story-guide-pipeline';
import { BookService } from '../../book/book.service';
import { StoryGuideEstimator } from '../../story-guides/story-guide-estimator.service';
import { StoryGuideFeature } from '../../story-guides/story-guide.feature';
import { StoryGuidesRepository } from '../../story-guides/story-guides.repository';
import { StoryTextService } from '../../story-guides/story-text.service';
import { BkStoryGuideEstimator } from './bk-story-guide-estimator';
import { BkStoryGuideFeature } from './bk-story-guide-feature';
import { createBkStoryGuidePipeline } from './bk-story-guide-pipeline';
import { BkStoryGuideRunner } from './bk-story-guide-runner.service';

@Module({
  imports: [AiModule, BookKnowledgeModule],
  providers: [BkStoryGuideRunner],
  exports: [BkStoryGuideRunner],
})
export class BkPipelineModule {}

/**
 * Listed in StoryGuidesModule's providers after upstream's own: the pipeline in place of upstream's, an
 * estimator that prices the `bk` step and a feature that refuses jobs BK cannot build (the later provider of a token wins).
 */
export const bkStoryGuidePipelineProviders = [
  {
    provide: StoryGuideEstimator,
    useFactory: (
      settings: AiSettingsService,
      connections: AiConnectionService,
      rates: AiStepRates,
      texts: StoryTextService,
      runner: BkStoryGuideRunner,
      jobs: AiJobsService,
    ) => new BkStoryGuideEstimator([settings, connections, rates], texts, runner, jobs),
    inject: [AiSettingsService, AiConnectionService, AiStepRates, StoryTextService, BkStoryGuideRunner, AiJobsService],
  },
  { provide: STORY_GUIDE_PIPELINE, useFactory: createBkStoryGuidePipeline, inject: [BkStoryGuideRunner] },
  {
    provide: StoryGuideFeature,
    useFactory: (
      texts: StoryTextService,
      repository: StoryGuidesRepository,
      settings: AiSettingsService,
      books: BookService,
      estimator: StoryGuideEstimator,
      pipeline: StoryGuidePipeline,
      runner: BkStoryGuideRunner,
    ) => new BkStoryGuideFeature([texts, repository, settings, books, estimator, pipeline], runner),
    inject: [StoryTextService, StoryGuidesRepository, AiSettingsService, BookService, StoryGuideEstimator, STORY_GUIDE_PIPELINE, BkStoryGuideRunner],
  },
];
