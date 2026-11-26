import type { BookKnowledgeXrayPayload } from '@bookorbit/types';

import type { AiAssembleContext } from '../../ai-jobs/ai-feature';
import { storyGuidePipelineName } from '../../story-guides/pipeline/create-pipeline';
import type { StoryGuidePipeline } from '../../story-guides/pipeline/story-guide-pipeline';
import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { assembleBkStoryGuide } from './bk-story-guide-assemble';
import type { BkStoryGuideRunner } from './bk-story-guide-runner.service';
import { BK_PAYLOAD_VERSION, BK_PROMPT_VERSION } from './bk-versions';

/** The story guide pipeline whose one step is Book Knowledge's build. */
export function createBkStoryGuidePipeline(runner: BkStoryGuideRunner): StoryGuidePipeline {
  const steps: StoryGuidePipeline['steps'] = [
    {
      id: 'bk',
      version: BK_PROMPT_VERSION,
      slot: 'fast',
      dependsOn: [],
      units: () => [{ id: 'book' }],
      fingerprint: (ctx) => `${ctx.subject.bookId}:${ctx.subject.key}`,
      run: (ctx) => runner.build(ctx),
    },
  ];
  const pipeline = storyGuidePipelineName(steps, BK_PAYLOAD_VERSION);

  return {
    steps,
    assembleVersion: BK_PAYLOAD_VERSION,
    assemble: (ctx: AiAssembleContext<StoryGuideSubject>) =>
      Promise.resolve(
        assembleBkStoryGuide(ctx.results('bk').get('book') as BookKnowledgeXrayPayload, {
          textKey: ctx.subject.key,
          pipeline,
          models: ctx.job.models,
          coverage: ctx.coverage,
          builtAt: new Date().toISOString(),
        }),
      ),
    render: (payload, format) => (format === 1 ? payload : null),
  };
}
