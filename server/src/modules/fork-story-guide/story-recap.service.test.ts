import { ForbiddenException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeUser } from '../../common/test-utils/make-user';
import { BookService } from '../book/book.service';
import { EpubDomService } from '../position-converter/epub-dom.service';
import { parseChapterDocument } from '../position-converter/position-converter.core';
import { readingHelpError, ReadingHelpService } from '../reading-help/reading-help.service';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { StoryRecapService } from './story-recap.service';

const fileId = 12;
const user = makeUser({ id: 42 });
const cfi = 'epubcfi(/6/4!/4/2/1:16)';
const percentage = 25;
const chapter = parseChapterDocument('<html><head/><body><p>The door opened. The lantern went out.</p></body></html>');
const guide = {
  language: 'fr',
  entities: [],
  ties: [],
  sections: [
    { s: 0, title: 'The road' },
    { s: 1, title: 'The door' },
  ],
  summaries: [
    { through: { s: 0, end: true }, text: 'They reached the house.' },
    { through: { s: 1, o: 0, q: 'The door opened.' }, text: 'They opened the door.' },
    { through: { s: 1, o: 17, q: 'The lantern went out.' }, text: 'It went dark.' },
  ],
};
const previously = [
  { s: 0, title: 'The road', text: 'They reached the house.' },
  { s: 1, title: 'The door', text: 'They opened the door.' },
];

describe('StoryRecapService', () => {
  const getProgress = vi.fn();
  const content = vi.fn();
  const getChapter = vi.fn();
  const answer = vi.fn();
  let service: StoryRecapService;

  beforeEach(async () => {
    getProgress.mockReset().mockResolvedValue({ cfi, percentage });
    content.mockReset().mockResolvedValue({ kind: 'found', body: guide });
    getChapter.mockReset().mockResolvedValueOnce(chapter).mockResolvedValue(null);
    answer.mockReset().mockResolvedValue([{ type: 'done', text: 'The door is open.', cached: true, careful: false }]);

    const module = await Test.createTestingModule({
      providers: [
        StoryRecapService,
        { provide: BookService, useValue: { getProgress } },
        { provide: StoryGuidesService, useValue: { content } },
        { provide: EpubDomService, useValue: { getChapter } },
        { provide: ReadingHelpService, useValue: { answer } },
      ],
    }).compile();
    service = module.get(StoryRecapService);
  });

  const recap = (stop = true, acceptLanguage?: string, signal = new AbortController().signal) =>
    service.recap(fileId, user, stop, acceptLanguage, signal);

  it.each([
    ['no progress row', null],
    ['progress without a CFI', { cfi: null, percentage }],
  ])('gives no-position for %s', async (_, progress) => {
    getProgress.mockResolvedValue(progress);
    await expect(recap()).resolves.toEqual({ state: 'no-position', cut: null, previously: [], stop: { state: 'skipped' } });
    expect(getProgress).toHaveBeenCalledExactlyOnceWith(user.id, fileId, user);
    expect(content).not.toHaveBeenCalled();
    expect(getChapter).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([0, 100])('uses the saved CFI at %s percent', async (savedPercentage) => {
    getProgress.mockResolvedValue({ cfi, percentage: savedPercentage });
    await expect(recap(false)).resolves.toMatchObject({
      position: { percentage: savedPercentage },
      cut: { s: 1, placedQuotes: ['The door opened.'] },
    });
  });

  it('skips the model with stop=0 and still returns previously', async () => {
    await expect(recap(false)).resolves.toMatchObject({ state: 'ok', previously, stop: { state: 'skipped' } });
    expect(answer).not.toHaveBeenCalled();
  });

  it('answers recap-stop with one pre-position passage and the guide language', async () => {
    answer.mockResolvedValue(
      (function* () {
        yield { type: 'delta', text: 'The door' };
        yield { type: 'done', text: 'The door is open.', cached: false, careful: false };
      })(),
    );
    const signal = new AbortController().signal;

    await expect(recap(true, 'de-DE', signal)).resolves.toEqual({
      state: 'ok',
      position: { chapterIndex: 1, percentage, cfi, chapterTitle: 'The door' },
      cut: { s: 1, placedQuotes: ['The door opened.'] },
      previously,
      stop: { state: 'ok', text: 'The door is open.', cached: false },
    });
    expect(answer).toHaveBeenCalledExactlyOnceWith(user, { kind: 'recap-stop', fileId, language: 'fr', passages: ['The door opened.'] }, signal);
    expect(content).toHaveBeenCalledExactlyOnceWith(fileId, [1], user);
  });

  it.each([
    ['READING_HELP_OFF', 'off'],
    ['READING_HELP_BUDGET', 'budget'],
    ['READING_HELP_READER_CAP', 'cap'],
    ['READING_HELP_PROVIDER', 'failed'],
  ] as const)('maps %s to %s and still returns previously', async (code, state) => {
    answer.mockRejectedValue(readingHelpError(code, 'Reading help unavailable'));
    await expect(recap()).resolves.toMatchObject({ state: 'ok', previously, stop: { state, code } });
  });

  it('maps an error event to failed', async () => {
    answer.mockResolvedValue([{ type: 'error', errorCode: 'READING_HELP_TIMEOUT', message: 'Timed out' }]);
    await expect(recap()).resolves.toMatchObject({ previously, stop: { state: 'failed', code: 'READING_HELP_TIMEOUT' } });
  });

  it('keeps only earlier chapters when a CFI offset cannot be placed', async () => {
    getProgress.mockResolvedValue({ cfi: 'epubcfi(/6/4!/4/20/1:3)', percentage });
    await expect(recap()).resolves.toMatchObject({ previously: [previously[0]], stop: { state: 'unplaced' } });
    expect(answer).not.toHaveBeenCalled();
  });

  it('omits position and summaries when the CFI has no spine step', async () => {
    getProgress.mockResolvedValue({ cfi: 'epubcfi(/4/2/1:3)', percentage });
    await expect(recap()).resolves.toEqual({ state: 'ok', cut: null, previously: [], stop: { state: 'unplaced' } });
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    ['pt-BR;q=0.8, en;q=0.9', 'pt-BR'],
    [undefined, 'en'],
  ])('answers without a guide using language %s', async (acceptLanguage, language) => {
    content.mockResolvedValue({ kind: 'missing', reason: 'none' });
    await expect(recap(true, acceptLanguage)).resolves.toMatchObject({
      position: { chapterTitle: null },
      previously: [],
      stop: { state: 'ok', text: 'The door is open.', cached: true },
    });
    expect(answer).toHaveBeenCalledWith(user, expect.objectContaining({ language }), expect.any(AbortSignal));
  });

  it.each([
    [
      'the nearest earlier titled section',
      [
        { s: 0, title: 'The road' },
        { s: 1, title: '  ' },
      ],
      'The road',
    ],
    ['nothing when only a later section is titled', [{ s: 0 }, { s: 2, title: 'Later' }], null],
  ])('names an untitled current chapter after %s', async (_, sections, chapterTitle) => {
    content.mockResolvedValue({ kind: 'found', body: { ...guide, sections } });
    await expect(recap(false)).resolves.toMatchObject({ position: { chapterIndex: 1, chapterTitle } });
  });

  it('propagates file access denied as 403', async () => {
    getProgress.mockRejectedValue(new ForbiddenException());
    await expect(recap()).rejects.toMatchObject({ status: 403 });
    expect(content).not.toHaveBeenCalled();
    expect(getChapter).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it('logs no start or end for a stop=0 read, and both for a Reading help recap', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await recap(false);
    expect(log).not.toHaveBeenCalled();
    getChapter.mockReset().mockResolvedValueOnce(chapter).mockResolvedValue(null);
    await recap(true);
    expect(log.mock.calls.map(([line]) => String(line).split(' - ')[0])).toEqual([
      expect.stringMatching(/^\[story_guide\.recap\] \[start\] fileId=12 userId=42 includeStop=true$/),
      expect.stringMatching(/^\[story_guide\.recap\] \[end\] fileId=12 userId=42 includeStop=true durationMs=\d+ chapterIndex=1 /),
    ]);
    log.mockRestore();
  });

  it('logs a failed stop=0 read', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    getProgress.mockRejectedValue(new ForbiddenException());
    await expect(recap(false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[story_guide\.recap\] \[fail\] fileId=12 userId=42 includeStop=false durationMs=\d+ /),
    );
    warn.mockRestore();
  });
});
