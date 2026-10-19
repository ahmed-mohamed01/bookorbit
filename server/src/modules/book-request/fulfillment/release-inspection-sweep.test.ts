import { IndexerSearchException } from '../indexers/indexer-adapter';
import { HttpException } from '@nestjs/common';
import type { ReleaseCandidateItem, ReleaseInspectionRanking } from '@bookorbit/types';
import { sweepUnknownReleases, InspectionRefusal, inspectionRefusal } from './release-inspection-sweep';

const release = (i: number, extra = {}) =>
  ({ indexerId: 9, guid: String(i), score: 90, seeders: 10, tier: null, inspectionWanted: true, ...extra }) as ReleaseCandidateItem;
const promotion: ReleaseInspectionRanking = {
  score: 95,
  tier: 0,
  tierName: 'EPUB',
  profileMismatch: null,
  format: 'epub',
  formats: ['epub'],
  fileCount: 1,
  bookCount: 1,
  inspectionWanted: false,
};

describe('sweepUnknownReleases', () => {
  it.each([403, 429])('recognises HTTP %s refusals', (status) => {
    expect(inspectionRefusal(new HttpException('refused', status))?.reason).toBe('http');
  });
  it('uses typed status instead of free error messages', () => {
    expect(inspectionRefusal({ status: 429 })?.reason).toBe('http');
    expect(inspectionRefusal(new Error('403 challenge'))).toBeNull();
    expect(inspectionRefusal(new DOMException('aborted', 'AbortError'))?.reason).toBe('timeout');
  });
  it('resets consecutive timeouts after a successful inspection', async () => {
    const inspect = vi
      .fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>()
      .mockRejectedValueOnce(new InspectionRefusal('timeout'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new InspectionRefusal('timeout'))
      .mockResolvedValueOnce(promotion);
    const result = await sweepUnknownReleases({ ranked: [release(1), release(2), release(3), release(4)], minScore: 80, inspect, concurrency: 1 });
    expect(result).toMatchObject({ inspected: 4, promoted: 1, stoppedBy: 'tier' });
  });
  it('stops on a challenge', async () => {
    const inspect = vi
      .fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>()
      .mockRejectedValue(new InspectionRefusal('challenge'));
    expect(await sweepUnknownReleases({ ranked: [release(1), release(2)], minScore: 80, inspect })).toMatchObject({
      inspected: 1,
      stoppedBy: 'refused',
    });
  });
  it('continues past a lower-tier promotion in score order', async () => {
    const inspect = vi
      .fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>()
      .mockResolvedValueOnce({ ...promotion, tier: 1 })
      .mockResolvedValueOnce(promotion);
    const result = await sweepUnknownReleases({
      ranked: [release(1, { score: 85 }), release(2, { score: 95 })],
      minScore: 80,
      inspect,
      concurrency: 1,
    });
    expect(inspect.mock.calls.map(([r]) => r.guid)).toEqual(['2', '1']);
    expect(result).toMatchObject({ inspected: 2, promoted: 2, stoppedBy: 'tier' });
  });
  it('stops after one tier-zero promotion', async () => {
    const inspect = vi.fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>().mockResolvedValue(promotion);
    const result = await sweepUnknownReleases({ ranked: [release(1), release(2)], minScore: 80, inspect });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ inspected: 1, promoted: 1, stoppedBy: 'tier' });
  });
  it('limits thirty candidates to twenty inspections', async () => {
    const inspect = vi.fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>().mockResolvedValue(null);
    expect(await sweepUnknownReleases({ ranked: Array.from({ length: 30 }, (_, i) => release(i)), minScore: 80, inspect })).toMatchObject({
      inspected: 20,
      stoppedBy: 'ceiling',
    });
  });
  it('keeps at most two inspections in flight', async () => {
    let active = 0;
    let peak = 0;
    await sweepUnknownReleases({
      ranked: Array.from({ length: 8 }, (_, i) => release(i)),
      minScore: 80,
      inspect: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return null;
      },
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
  it('stops on 429 without touching later releases', async () => {
    const inspect = vi
      .fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>()
      .mockRejectedValue(new IndexerSearchException('throttled', 'The indexer answered 429 for that download link'));
    const ranked = [release(1), release(2)];
    expect(await sweepUnknownReleases({ ranked, minScore: 80, inspect })).toMatchObject({ releases: ranked, inspected: 1, stoppedBy: 'refused' });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('skips low scores and stored facts without spending the limit', async () => {
    const inspect = vi.fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>().mockResolvedValue(null);
    await sweepUnknownReleases({
      ranked: [release(1, { score: 70 }), release(2, { inspectionWanted: false }), release(3)],
      minScore: 80,
      inspect,
      limit: 1,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(release(3));
  });
  it('stops after two consecutive timeouts but continues after one', async () => {
    const inspect = vi
      .fn<(release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>>()
      .mockRejectedValue(new InspectionRefusal('timeout'));
    expect(await sweepUnknownReleases({ ranked: [release(1), release(2), release(3)], minScore: 80, inspect, concurrency: 1 })).toMatchObject({
      inspected: 2,
      stoppedBy: 'refused',
    });
  });
});
