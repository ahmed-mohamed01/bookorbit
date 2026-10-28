import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DEFAULT_EDITION_LINK_SETTINGS } from './edition-link-settings.service';
import { WorkProgressMirrorService } from './work-progress-mirror.service';

type AnyMock = Mock<(...args: never[]) => unknown>;

const at = new Date('2026-01-01T00:00:00.000Z');
const occurredAt = new Date('2026-06-01T12:00:00.000Z');
const work = {
  linkId: 4,
  canonicalBookId: 20,
  members: [
    { bookId: 10, role: 'text', isPrimary: true, createdAt: at },
    { bookId: 20, role: 'audio', isPrimary: true, createdAt: at },
    { bookId: 11, role: 'text', isPrimary: false, createdAt: at },
  ],
};
const state = (bookId: number, fields: Record<string, unknown> = {}) => ({
  bookId,
  primaryFileId: bookId * 100,
  filePercentage: null,
  fileLastReadAt: null,
  fileProjectedAt: null,
  audioPercentage: null,
  audioUpdatedAt: null,
  ...fields,
});

describe('WorkProgressMirrorService', () => {
  let settings: { get: AnyMock };
  let scope: { resolve: AnyMock };
  let repo: Record<string, AnyMock>;
  let events: { notifyBooksChanged: AnyMock };
  let achievementEvents: { emit: AnyMock; on: AnyMock; removeListener: AnyMock };
  let service: WorkProgressMirrorService;

  beforeEach(() => {
    settings = { get: vi.fn().mockResolvedValue(DEFAULT_EDITION_LINK_SETTINGS) };
    scope = { resolve: vi.fn().mockResolvedValue(work) };
    repo = {
      findMirrorTargetStates: vi.fn().mockResolvedValue([state(10), state(11)]),
      hasReadyAlignment: vi.fn().mockResolvedValue(false),
      hasReadAlongOffsets: vi.fn().mockResolvedValue(false),
      mirrorReadingProgress: vi.fn().mockResolvedValue(true),
      mirrorAudiobookProgress: vi.fn().mockResolvedValue(true),
      findAudioPlayOrder: vi.fn().mockResolvedValue([{ id: 5, durationSeconds: 1000 }]),
    };
    events = { notifyBooksChanged: vi.fn().mockResolvedValue(undefined) };
    achievementEvents = { emit: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    service = new WorkProgressMirrorService(achievementEvents as never, settings as never, scope as never, repo as never, events as never);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const audioEvent = { userId: 7, bookId: 20, progress: 40, source: 'audiobookshelf' as const, occurredAt };

  it('writes the percentage onto every other variant without emitting a progress event', async () => {
    const outcomes = await service.handle(audioEvent);

    expect(outcomes).toEqual(
      new Map([
        [10, 'written'],
        [11, 'written'],
      ]),
    );
    expect(repo.mirrorReadingProgress).toHaveBeenCalledWith(7, 1000, 40, occurredAt);
    expect(repo.mirrorReadingProgress).toHaveBeenCalledWith(7, 1100, 40, occurredAt);
    expect(achievementEvents.emit).not.toHaveBeenCalled();
    expect(events.notifyBooksChanged).toHaveBeenCalledWith(7, [10, 11], []);
  });

  it('leaves an aligned primary pair to the alignment sync but still reaches a duplicate', async () => {
    repo.hasReadyAlignment!.mockImplementation((textBookId: number) => Promise.resolve(textBookId === 10));

    const outcomes = await service.handle(audioEvent);

    expect(outcomes.get(10)).toBe('skipped_owned');
    expect(outcomes.get(11)).toBe('written');
  });

  it('never overwrites a variant read more recently, nor one already within half a point', async () => {
    repo.findMirrorTargetStates!.mockResolvedValue([
      state(10, { filePercentage: 12, fileLastReadAt: new Date('2026-06-02T00:00:00.000Z') }),
      state(11, { filePercentage: 40.2, fileLastReadAt: at }),
    ]);

    const outcomes = await service.handle(audioEvent);

    expect(outcomes).toEqual(
      new Map([
        [10, 'skipped_newer'],
        [11, 'skipped_close'],
      ]),
    );
    expect(repo.mirrorReadingProgress).not.toHaveBeenCalled();
  });

  it('positions the audiobook by the percentage of its play order', async () => {
    repo.findMirrorTargetStates!.mockResolvedValue([state(20), state(11)]);

    await service.handle({ userId: 7, bookId: 10, progress: 25, source: 'web_reader', occurredAt });

    expect(repo.mirrorAudiobookProgress).toHaveBeenCalledWith(7, 20, 5, 250, 25, occurredAt);
  });

  it('does nothing unless rough position sync is on', async () => {
    for (const positionSync of ['precise', 'off'] as const) {
      settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, positionSync });
      await expect(service.handle(audioEvent)).resolves.toEqual(new Map());
    }
    settings.get.mockResolvedValue({ ...DEFAULT_EDITION_LINK_SETTINGS, enabled: false });
    await expect(service.handle(audioEvent)).resolves.toEqual(new Map());
    expect(scope.resolve).not.toHaveBeenCalled();
  });
});
