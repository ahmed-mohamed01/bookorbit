import { readBookText } from '../../story-guides/text/book-text-reader';
import { join } from 'node:path';
import { buildArtifact, buildArtifactInProcess } from './build-pipeline';
import { extractBookText } from './book-text-stage';
import { extractEpubText } from './epub-text.js';
import type { TextStage } from './model';
import { bodySections } from '../xray/xray-evidence';

vi.mock('../../story-guides/text/book-text-reader', () => ({ readBookText: vi.fn() }));
vi.mock('./epub-text.js', () => ({ extractEpubText: vi.fn() }));

it.each(['epub', 'kepub'])('extractBookText delegates %s to extractEpubText', async (format) => {
  vi.clearAllMocks();
  const path = `/books/test.${format}`;
  const stage: TextStage = { sentences: [], seeds: [], spineBytes: [] };
  vi.mocked(extractEpubText).mockResolvedValue(stage);
  await expect(extractBookText(path, format)).resolves.toBe(stage);
  expect(extractEpubText).toHaveBeenCalledExactlyOnceWith(path);
});

it('extractBookText builds sentences from readBookText for mobi', async () => {
  vi.mocked(readBookText).mockResolvedValue({
    kind: 'mobi',
    languages: ['en'],
    sections: ['Alice walked home. She rested.', 'Leave this out.', 'Chloé waited.', 'Leave this out, too.'].map((text, index) => ({
      index,
      linear: index % 2 === 0,
      titles: [],
      text,
      blocks: [0],
      hash: '',
      error: null,
    })),
  });

  const stage = await extractBookText('/books/test.mobi', 'mobi');
  expect(readBookText).toHaveBeenCalledExactlyOnceWith('/books/test.mobi');
  expect(stage.sentences.map(({ ordinal, spineIndex, text }) => [ordinal, spineIndex, text])).toEqual([
    [1, 0, 'Alice walked home.'],
    [2, 0, 'She rested.'],
    [3, 2, 'Chloé waited.'],
  ]);
  expect(stage.spineBytes).toEqual([Buffer.byteLength('Alice walked home. She rested.'), 0, Buffer.byteLength('Chloé waited.'), 0]);

  const { artifact } = await buildArtifactInProcess('/books/test.mobi', { format: 'mobi', fingerprint: 'f'.repeat(64) });
  expect(artifact.sentences.map(({ ordinal, spineIndex }) => [ordinal, spineIndex])).toEqual([
    [1, 0],
    [2, 0],
    [3, 2],
  ]);
  expect(artifact.spineBytes).toEqual(stage.spineBytes);
});

it('extractBookText marks only story sections as body for mobi', async () => {
  const story = Array.from({ length: 120 }, (_, index) => `Mara crossed bridge ${index}.`).join(' ');
  const section = (index: number, title: string | null, text: string) => ({
    index,
    linear: true,
    titles: title ? [title] : [],
    text,
    blocks: [0],
    hash: '',
    error: null,
  });
  vi.mocked(readBookText).mockResolvedValue({
    kind: 'mobi',
    languages: ['en'],
    sections: [section(0, null, 'Praise for the series.'), section(1, 'Chapter One', story), section(2, 'Also by', 'Another book.')],
  });

  const stage = await extractBookText('/books/test.mobi', 'mobi');

  expect(stage.sentences.map(({ ordinal }) => ordinal)).toEqual(stage.sentences.map((_, index) => index + 1));
  expect(stage.sentences[0]).toMatchObject({ spineIndex: 0, structure: 'front' });
  expect(stage.sentences.filter(({ spineIndex }) => spineIndex === 1).every(({ structure }) => structure === 'body')).toBe(true);
  expect(stage.sentences.at(-1)).toMatchObject({ spineIndex: 2, structure: 'other', text: 'Another book.' });
  expect(stage.spineBytes[2]).toBe(Buffer.byteLength('Another book.'));
  const kept = bodySections(stage.sentences, stage.sentences.length).map(({ s }) => s);
  expect(kept).toEqual([1]);
});

it.each(['mobi', 'azw3'])('builds a %s artifact through the real worker', async (format) => {
  const path = join(__dirname, `../../story-guides/test-fixtures/a-study-in-scarlet.${format}`);
  const { artifact } = await buildArtifact(path, { format });
  expect(artifact.sentences.length).toBeGreaterThan(100);
  expect(artifact.sentences[0].ordinal).toBe(1);
  expect(artifact.spineBytes?.[artifact.sentences.at(-1)!.spineIndex]).toBeGreaterThan(0);
});
