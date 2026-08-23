import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { ReadingAlignmentStatusService } from './reading-alignment-status.service';

const USER = { id: 42, isSuperuser: false } as RequestUser;
const BOOK_ID = 7;
const TEXT_BOOK_ID = 8;
const AUDIO_BOOK_ID = BOOK_ID;

function alignmentRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 3,
    textBookId: TEXT_BOOK_ID,
    audioBookId: AUDIO_BOOK_ID,
    ebookFileId: 5,
    status: 'ready',
    samplesDone: 10,
    samplesTotal: 10,
    anchorCount: 4,
    builtAt: new Date('2026-02-02T00:00:00Z'),
    ...overrides,
  };
}

function build(overrides?: {
  existing?: unknown;
  buildResult?: Promise<void>;
  verifyThrows?: boolean;
  libraryId?: number | null;
  pair?: { textBookId: number; audioBookId: number } | null;
  enabled?: boolean;
  whisperAvailable?: boolean;
  atCapacity?: boolean;
}) {
  const config = { readingAlignmentEnabled: overrides?.enabled ?? true };
  const repo = {
    getAlignmentByPair: vi.fn().mockResolvedValue(overrides?.existing ?? undefined),
  };
  const buildService = {
    buildAlignment: vi.fn().mockReturnValue(overrides?.buildResult ?? Promise.resolve()),
    isAtCapacity: vi.fn().mockReturnValue(overrides?.atCapacity ?? false),
  };
  const whisper = {
    isAvailable: vi.fn().mockReturnValue(overrides?.whisperAvailable ?? true),
  };
  const verifyBookAccess = overrides?.verifyThrows
    ? vi.fn().mockRejectedValue(new ForbiddenException('No access to this library'))
    : overrides?.libraryId === null
      ? vi.fn().mockRejectedValue(new NotFoundException(`Book ${BOOK_ID} not found`))
      : vi.fn().mockResolvedValue(undefined);
  const bookService = { verifyBookAccess };
  const pairService = {
    resolveAlignmentPair: vi
      .fn()
      .mockResolvedValue(overrides?.pair === undefined ? { textBookId: TEXT_BOOK_ID, audioBookId: AUDIO_BOOK_ID } : overrides.pair),
  };
  const service = new ReadingAlignmentStatusService(
    config as never,
    repo as never,
    buildService as never,
    whisper as never,
    bookService as never,
    pairService as never,
  );
  return { service, config, repo, buildService, whisper, bookService, pairService };
}

describe('ReadingAlignmentStatusService.requestBuild', () => {
  beforeEach(() => vi.clearAllMocks());

  it("kicks off buildAlignment and returns 'building' when no row exists yet", async () => {
    const { service, buildService } = build({ existing: undefined });

    const result = await service.requestBuild(BOOK_ID, USER);

    expect(buildService.buildAlignment).toHaveBeenCalledWith(BOOK_ID, USER, false);
    expect(result).toEqual({ status: 'building' });
  });

  it('reports the existing status while still re-triggering the build', async () => {
    const { service, repo, buildService } = build({ existing: alignmentRow({ status: 'ready' }) });

    const result = await service.requestBuild(BOOK_ID, USER);

    expect(buildService.buildAlignment).toHaveBeenCalledWith(BOOK_ID, USER, false);
    expect(repo.getAlignmentByPair).toHaveBeenCalledWith(TEXT_BOOK_ID, AUDIO_BOOK_ID);
    expect(result).toEqual({ status: 'ready' });
  });

  it('forwards a force rebuild to the build service', async () => {
    const { service, buildService } = build({ existing: alignmentRow({ status: 'ready' }) });

    await service.requestBuild(BOOK_ID, USER, true);

    expect(buildService.buildAlignment).toHaveBeenCalledWith(BOOK_ID, USER, true);
  });

  it("returns 'disabled' without building when reading alignment is off", async () => {
    const { service, buildService } = build({ enabled: false });

    await expect(service.requestBuild(BOOK_ID, USER)).resolves.toEqual({ status: 'disabled' });
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });

  it("returns 'unavailable' without building when whisper is not configured", async () => {
    const { service, buildService } = build({ whisperAvailable: false });

    await expect(service.requestBuild(BOOK_ID, USER)).resolves.toEqual({ status: 'unavailable' });
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });

  it("returns 'busy' without building when the global build cap is reached", async () => {
    const { service, buildService } = build({ existing: undefined, atCapacity: true });

    await expect(service.requestBuild(BOOK_ID, USER)).resolves.toEqual({ status: 'busy' });
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });

  it('still re-triggers a build already in flight even at capacity', async () => {
    const { service, buildService } = build({ existing: alignmentRow({ status: 'building' }), atCapacity: true });

    const result = await service.requestBuild(BOOK_ID, USER);

    expect(result).toEqual({ status: 'building' });
    expect(buildService.buildAlignment).toHaveBeenCalledWith(BOOK_ID, USER, false);
  });

  it("returns 'none' without building when the book has no alignment pair", async () => {
    const { service, repo, buildService } = build({ pair: null });

    await expect(service.requestBuild(BOOK_ID, USER)).resolves.toEqual({ status: 'none' });
    expect(repo.getAlignmentByPair).not.toHaveBeenCalled();
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });

  it('does not await the build: returns even when the build promise never settles', async () => {
    let settle: (() => void) | undefined;
    const never = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { service, buildService } = build({ existing: undefined, buildResult: never });

    // If requestBuild awaited the build, this would hang until the test times out.
    const result = await service.requestBuild(BOOK_ID, USER);

    expect(buildService.buildAlignment).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'building' });
    settle?.();
  });

  it('swallows a rejected build promise so the request never crashes', async () => {
    const rejected = Promise.reject(new Error('whisper exploded'));
    const { service } = build({ existing: undefined, buildResult: rejected });

    const result = await service.requestBuild(BOOK_ID, USER);
    expect(result).toEqual({ status: 'building' });

    // Let the swallowed rejection flush; an unhandled rejection would fail the run.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('throws NotFound and never builds when the book does not exist', async () => {
    const { service, buildService } = build({ libraryId: null });

    await expect(service.requestBuild(BOOK_ID, USER)).rejects.toBeInstanceOf(NotFoundException);
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });

  it('propagates a Forbidden and never builds when the user lacks access', async () => {
    const { service, buildService } = build({ verifyThrows: true });

    await expect(service.requestBuild(BOOK_ID, USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(buildService.buildAlignment).not.toHaveBeenCalled();
  });
});

describe('ReadingAlignmentStatusService.getStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the status/progress shape when a row exists', async () => {
    const { service } = build({ existing: alignmentRow() });

    const result = await service.getStatus(BOOK_ID, USER);

    expect(result).toEqual({
      status: 'ready',
      samplesDone: 10,
      samplesTotal: 10,
      anchorCount: 4,
      builtAt: new Date('2026-02-02T00:00:00Z'),
    });
  });

  it("returns { status: 'none' } when no alignment row exists", async () => {
    const { service } = build({ existing: undefined });
    expect(await service.getStatus(BOOK_ID, USER)).toEqual({ status: 'none' });
  });

  it("returns { status: 'none' } when the book has no alignment pair", async () => {
    const { service, repo } = build({ pair: null });

    await expect(service.getStatus(BOOK_ID, USER)).resolves.toEqual({ status: 'none' });
    expect(repo.getAlignmentByPair).not.toHaveBeenCalled();
  });

  it('propagates a Forbidden from the access check', async () => {
    const { service } = build({ verifyThrows: true, existing: alignmentRow() });
    await expect(service.getStatus(BOOK_ID, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFound when the book does not exist', async () => {
    const { service } = build({ libraryId: null });
    await expect(service.getStatus(BOOK_ID, USER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
