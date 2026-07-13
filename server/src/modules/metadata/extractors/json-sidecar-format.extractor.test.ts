import type { MockedFunction } from 'vitest';
import { readFile } from 'fs/promises';

import { JsonSidecarFormatExtractor } from './json-sidecar-format.extractor';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = readFile as MockedFunction<typeof readFile>;

function mockJsonContent(text: string): void {
  mockedReadFile.mockResolvedValue(text as unknown as Buffer);
}

describe('JsonSidecarFormatExtractor', () => {
  const extractor = new JsonSidecarFormatExtractor();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a valid ABS metadata.json into ParsedBookData with a null cover', async () => {
    mockJsonContent(JSON.stringify({ title: 'Firefight', asin: 'B00OYX5G5W', series: ['Reckoners #2'] }));
    const result = await extractor.extract('/books/Book/metadata.json');
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Firefight');
    expect(result?.audibleId).toBe('B00OYX5G5W');
    expect(result?.seriesName).toBe('Reckoners');
    expect(result?.seriesIndex).toBe(2);
    expect(result?.cover).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    mockJsonContent('{ not valid json');
    expect(await extractor.extract('/books/Book/metadata.json')).toBeNull();
  });

  it('returns null when the JSON is not a plain object', async () => {
    mockJsonContent('["array", "top", "level"]');
    expect(await extractor.extract('/books/Book/metadata.json')).toBeNull();
  });

  it('returns null when no recognizable ABS field is present', async () => {
    mockJsonContent(JSON.stringify({ unrelated: 'value' }));
    expect(await extractor.extract('/books/Book/metadata.json')).toBeNull();
  });
});
