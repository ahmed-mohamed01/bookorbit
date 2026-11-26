import { describe, expect, it, vi } from 'vitest';

import type { StoryGuideSubject } from '../../story-guides/pipeline/story-guide-subject';
import { StoryGuideFeature } from '../../story-guides/story-guide.feature';
import { BkStoryGuideFeature } from './bk-story-guide-feature';

const subject = { key: 'k', bookId: 7, file: { id: 3 }, text: { sections: [] } } as unknown as StoryGuideSubject;

function make(enabled: boolean, sourceFileId: number | null = 3) {
  const runner = { enabled: vi.fn().mockResolvedValue(enabled), sourceFileId: vi.fn().mockResolvedValue(sourceFileId) };
  const pipeline = { steps: [{ id: 'bk', version: 1, slot: 'fast', dependsOn: [] }], assembleVersion: 1 };
  const feature = new BkStoryGuideFeature([{}, {}, {}, {}, {}, pipeline] as never, runner);
  const upstream = vi.spyOn(StoryGuideFeature.prototype, 'check').mockResolvedValue(null);
  return { feature, runner, upstream };
}

describe('BkStoryGuideFeature', () => {
  it("refuses with off while Book Knowledge is off, without upstream's check", async () => {
    const { feature, upstream } = make(false);
    await expect(feature.check(subject)).resolves.toEqual({ reason: 'off' });
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockRestore();
  });

  it('refuses a file Book Knowledge does not build from', async () => {
    const { feature, upstream } = make(true, 99);
    await expect(feature.check(subject)).resolves.toEqual({ reason: 'unreadable' });
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockRestore();
  });

  it("delegates to upstream's check when Book Knowledge can build", async () => {
    const { feature, upstream } = make(true);
    upstream.mockResolvedValue({ reason: 'too-short' });
    await expect(feature.check(subject)).resolves.toEqual({ reason: 'too-short' });
    expect(upstream).toHaveBeenCalledWith(subject);
    upstream.mockRestore();
  });

  it('reports whether Build can be offered', async () => {
    const off = make(false);
    await expect(off.feature.buildable()).resolves.toBe(false);
    off.upstream.mockRestore();
    const on = make(true);
    await expect(on.feature.buildable()).resolves.toBe(true);
    on.upstream.mockRestore();
  });

  it.each([
    ['negative', { coverage: -0.5 }, 0],
    ['above one', { coverage: 1.5 }, 1],
    ['NaN', { coverage: Number.NaN }, 1],
    ['infinity', { coverage: Number.POSITIVE_INFINITY }, 1],
    ['missing', {}, 1],
    ['null artifact', null, 1],
    ['within range', { coverage: 0.92 }, 0.92],
  ])('normalizes %s coverage', (_case, artifact, expected) => {
    const { feature, upstream } = make(true);
    expect(feature.coverageOf(artifact)).toBe(expected);
    upstream.mockRestore();
  });
});
