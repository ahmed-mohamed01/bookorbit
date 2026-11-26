import type { StoryGuideLine } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { parseChapterDocument } from '../position-converter/position-converter.core';
import { pickStretch, placeCfi, visibleSummaries } from './story-recap.core';

function chapterWith(text: string) {
  return parseChapterDocument(`<html><head/><body><p>${text}</p></body></html>`);
}

function chapterTexts(...texts: string[]) {
  return vi.fn((index: number) => Promise.resolve(texts[index] ?? null));
}

describe('placeCfi', () => {
  it('finds chapter 3 and the offset of a text node point', async () => {
    const chapter = vi.fn().mockResolvedValue(chapterWith('One   two three.'));
    await expect(placeCfi('epubcfi(/6/8!/4/2/1:9)', chapter)).resolves.toEqual({ chapterIndex: 3, offset: 7 });
    expect(chapter).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('returns offset null for a path that does not resolve', async () => {
    const chapter = () => Promise.resolve(chapterWith('One two three.'));
    await expect(placeCfi('epubcfi(/6/8!/4/20/1:3)', chapter)).resolves.toEqual({ chapterIndex: 3, offset: null });
  });

  it('returns null for a CFI with no spine step', async () => {
    const chapter = vi.fn().mockResolvedValue(chapterWith('One two three.'));
    await expect(placeCfi('epubcfi(/4/2/1:3)', chapter)).resolves.toBeNull();
    expect(chapter).not.toHaveBeenCalled();
  });

  it('returns a slice offset when the prefix contains a supplementary Unicode character', async () => {
    const chapter = () => Promise.resolve(chapterWith('🌙   Two. Three.'));
    await expect(placeCfi('epubcfi(/6/8!/4/2/1:9)', chapter)).resolves.toEqual({ chapterIndex: 3, offset: 7 });
  });

  it('keeps the chapter index when the chapter document is unavailable', async () => {
    await expect(placeCfi('epubcfi(/6/8!/4/2/1:3)', () => Promise.resolve(null))).resolves.toEqual({ chapterIndex: 3, offset: null });
  });
});

describe('visibleSummaries', () => {
  it("keeps end anchors of earlier chapters and drops the current chapter's end anchor", () => {
    const summaries: StoryGuideLine[] = [
      { through: { s: 0, end: true }, text: 'First chapter.' },
      { through: { s: 1, o: 0, q: 'a quote' }, text: 'Earlier chapter part.' },
      { through: { s: 1, end: true }, text: 'Previous chapter.' },
      { through: { s: 2, end: true }, text: 'Current chapter.' },
      { through: { s: 3, end: true }, text: 'Later chapter.' },
    ];
    expect(visibleSummaries(summaries, { chapterIndex: 2, offset: null, text: '' }, (s) => (s === 0 ? 'Opening' : null))).toEqual([
      { s: 0, title: 'Opening', text: 'First chapter.' },
      { s: 1, title: null, text: 'Earlier chapter part.' },
      { s: 1, title: null, text: 'Previous chapter.' },
    ]);
  });

  it('keeps a quote anchor before the offset and drops one after it', () => {
    const text = chapterWith('The door opened. The lantern went out.').index.collapsed;
    const summaries: StoryGuideLine[] = [
      { through: { s: 2, o: 99, q: 'door\n  opened.' }, text: 'The door opens.' },
      { through: { s: 2, o: 0, q: 'lantern went out.' }, text: 'The room goes dark.' },
    ];
    const titleOf = () => 'The door';
    expect(visibleSummaries(summaries, { chapterIndex: 2, offset: 16, text }, titleOf)).toEqual([
      { s: 2, title: 'The door', text: 'The door opens.' },
    ]);
    expect(visibleSummaries(summaries, { chapterIndex: 2, offset: null, text }, titleOf)).toEqual([]);
  });

  it('drops a quote anchor when a later copy of its quote lies after the offset', () => {
    const text = chapterWith('He nodded. The door opened. He nodded.').index.collapsed;
    const summaries: StoryGuideLine[] = [
      { through: { s: 2, o: 0, q: 'The door opened.' }, text: 'The door opens.' },
      { through: { s: 2, o: 28, q: 'He nodded.' }, text: 'He agrees.' },
    ];
    expect(visibleSummaries(summaries, { chapterIndex: 2, offset: 27, text }, () => null)).toEqual([{ s: 2, title: null, text: 'The door opens.' }]);
    expect(visibleSummaries(summaries, { chapterIndex: 2, offset: text.length, text }, () => null)).toHaveLength(2);
  });
});

describe('pickStretch', () => {
  it('extends into the previous chapter when the current part is under 2000 chars', async () => {
    const previous = 'The gate stayed closed. '.repeat(100).trimEnd();
    const chapters = chapterTexts('An earlier chapter.', previous, 'The gate opened. Someone came in.');
    await expect(pickStretch(chapters, { chapterIndex: 2, offset: 16 })).resolves.toBe(`${previous}\n\nThe gate opened.`);
    expect(chapters.mock.calls).toEqual([[2], [1]]);
  });

  it('caps at 12000 chars and starts at a sentence boundary', async () => {
    const tail = `${'The wind howled all night. '.repeat(440)}At dawn it stopped.`;
    const text = `${'A long opening filled with words '.repeat(20)}finally ends. ${tail}`;
    expect(text.length).toBeGreaterThan(12000);
    expect(tail.length).toBeLessThan(12000);
    await expect(pickStretch(chapterTexts(`${text} Unread.`), { chapterIndex: 0, offset: text.length })).resolves.toBe(tail);
  });

  it('in chapter 0 near the start returns just that text', async () => {
    const chapters = chapterTexts(chapterWith('The door opened. The lantern went out.').index.collapsed);
    await expect(pickStretch(chapters, { chapterIndex: 0, offset: 16 })).resolves.toBe('The door opened.');
    expect(chapters).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('returns null for offset 0 in chapter 0', async () => {
    await expect(pickStretch(chapterTexts('The door opened.'), { chapterIndex: 0, offset: 0 })).resolves.toBeNull();
  });
});
