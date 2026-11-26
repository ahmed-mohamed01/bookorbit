import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { STORY_TEXT_EXTRACTION_VERSION } from '../../story-guides/text/extraction-version';
import { StoryGuidesService } from '../../story-guides/story-guides.service';
import './bk-story-guide-feature';

const builder = { id: 7, active: true, isSuperuser: false, permissions: [Permission.LibraryGenerateStoryGuide] } as unknown as RequestUser;

function statusWith(buildable: (() => Promise<boolean>) | undefined) {
  const text = {
    fileId: 11,
    extractionVersion: STORY_TEXT_EXTRACTION_VERSION,
    outcome: 'ready',
    textKey: 'a'.repeat(64),
    language: 'en',
    words: 42_000,
    sections: [],
  };
  const service = new StoryGuidesService(
    { id: 'story-guides', permission: Permission.LibraryGenerateStoryGuide, pipeline: 'p', steps: [], stepsToRun: () => [], buildable } as never,
    { status: vi.fn().mockResolvedValue({ job: null, ahead: null, artifact: null }), models: vi.fn().mockResolvedValue({}) } as never,
    { cached: vi.fn().mockResolvedValue(text), file: vi.fn().mockResolvedValue({ id: 11, bookId: 3, format: 'epub' }) } as never,
    {
      findBook: vi.fn().mockResolvedValue({ id: 3, primaryFileId: null, formatPriority: null }),
      findFiles: vi.fn().mockResolvedValue([{ id: 11, bookId: 3, format: 'epub', role: 'content', sizeBytes: 5, mediaOverlayAvailable: false }]),
    } as never,
    { verifyBookAccess: vi.fn() } as never,
    { features: vi.fn().mockResolvedValue({ 'story-guides': { enabled: true, limits: {} } }) } as never,
    {} as never,
    { estimate: vi.fn().mockResolvedValue({ words: 1, minutes: null, cost: null }) } as never,
  );
  return service.status(3, undefined, builder);
}

describe('story guide status with the Book Knowledge feature hook', () => {
  it('offers no Build, with the reason off, while Book Knowledge cannot build', async () => {
    const { status } = await statusWith(() => Promise.resolve(false));
    expect(status.build).toEqual({ allowed: false, reason: 'off' });
    expect(status.estimate).toBeUndefined();
  });

  it('offers Build when Book Knowledge can build or the feature has no hook', async () => {
    expect((await statusWith(() => Promise.resolve(true))).status.build).toEqual({ allowed: true });
    expect((await statusWith(undefined)).status.build).toEqual({ allowed: true });
  });
});
