import { describe, expect, it, vi } from 'vitest';
import type { AiAssembleContext } from '../../ai-jobs/ai-feature';
import { storyGuidePipelineName } from '../../story-guides/pipeline/create-pipeline';
import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { createBkStoryGuidePipeline } from './bk-story-guide-pipeline';
import type { BkStoryGuideRunner } from './bk-story-guide-runner.service';

const subject = { key: 'text-key', bookId: 7, text: { sections: [], language: 'en' } } as unknown as StoryGuideSubject;

function make() {
  const runner = { build: vi.fn() } as unknown as BkStoryGuideRunner;
  return { runner, pipeline: createBkStoryGuidePipeline(runner) };
}

describe('createBkStoryGuidePipeline', () => {
  it('one step bk on the fast slot', () => {
    const { pipeline } = make();
    expect(pipeline.steps).toHaveLength(1);
    expect(pipeline.steps[0]).toMatchObject({ id: 'bk', slot: 'fast', dependsOn: [] });
    expect(pipeline.steps[0]!.units({} as never)).toEqual([{ id: 'book' }]);
    expect(pipeline.steps[0]!.fingerprint({ subject } as never, { id: 'book' })).toBe('7:text-key');
  });

  it('render returns null for format 2', () => {
    const { pipeline } = make();
    expect(pipeline.render({ a: 1 }, 1)).toEqual({ a: 1 });
    expect(pipeline.render({ a: 1 }, 2)).toBeNull();
  });

  it('pipeline name changes when BK_PAYLOAD_VERSION changes', () => {
    const { pipeline } = make();
    expect(storyGuidePipelineName(pipeline.steps, pipeline.assembleVersion)).not.toBe(
      storyGuidePipelineName(pipeline.steps, pipeline.assembleVersion + 1),
    );
  });

  it('assembles the bk result with the job models and coverage', async () => {
    const { pipeline } = make();
    const bk = { entities: [], ties: [], links: [], sections: [] };
    const ctx = {
      subject,
      coverage: 1,
      job: { models: {} },
      results: () => new Map([['book', bk]]),
    } as unknown as AiAssembleContext<StoryGuideSubject>;
    const payload = (await pipeline.assemble(ctx)) as { format: number; textKey: string };
    expect(payload).toMatchObject({ format: 1, textKey: 'text-key' });
  });
});
