import { readFile } from 'fs/promises';
import type { MockedFunction } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonSidecarFormatExtractor } from '../metadata/extractors/json-sidecar-format.extractor';
import { classifyFile } from '../scanner/lib/classify';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = readFile as MockedFunction<typeof readFile>;

describe('Audiobookshelf sidecar classification', () => {
  it('classifies the exact metadata.json basename as JSON metadata', () => {
    expect(classifyFile('/books/Book/metadata.json')).toEqual({ format: 'json', role: 'metadata' });
  });

  it('does not treat differently-cased metadata JSON as an Audiobookshelf sidecar', () => {
    expect(classifyFile('/books/Book/Metadata.JSON')).toEqual({ format: 'json', role: 'supplement' });
  });

  it('keeps other JSON files supplementary', () => {
    expect(classifyFile('/books/Book/reader.json')).toEqual({ format: 'json', role: 'supplement' });
    expect(classifyFile('/books/Book/data.json')).toEqual({ format: 'json', role: 'supplement' });
  });

  it('classifies cover.jpg as a cover sidecar', () => {
    expect(classifyFile('/books/Book/cover.jpg')).toEqual({ format: 'jpg', role: 'cover' });
  });
});

describe('Audiobookshelf JSON sidecar extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts Audiobookshelf metadata.json fields without an embedded cover', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ title: 'Firefight', authors: ['Brandon Sanderson'], asin: 'B00OYX5G5W', series: ['Reckoners #2'] }) as unknown as Buffer,
    );

    await expect(new JsonSidecarFormatExtractor().extract('/books/Book/metadata.json')).resolves.toEqual(
      expect.objectContaining({
        title: 'Firefight',
        authors: [{ name: 'Brandon Sanderson', sortName: null }],
        audibleId: 'B00OYX5G5W',
        seriesName: 'Reckoners',
        seriesIndex: 2,
        cover: null,
      }),
    );
    expect(mockedReadFile).toHaveBeenCalledWith('/books/Book/metadata.json', 'utf8');
  });
});
