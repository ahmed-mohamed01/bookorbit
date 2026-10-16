import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readListing, type FileIndexSource } from './file-index-reader';

const fetchFileIndex = vi.hoisted(() => vi.fn());
vi.mock('./file-index-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./file-index-http')>()),
  fetchFileIndex,
}));

const signal = new AbortController().signal;

function source(overrides: Partial<FileIndexSource> = {}): FileIndexSource {
  return {
    listingUrl: 'https://files.example/index.json',
    baseUrl: 'https://files.example/',
    format: null,
    keyMap: {},
    authorization: null,
    ...overrides,
  };
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

describe('readListing', () => {
  beforeEach(() => fetchFileIndex.mockReset());

  it('detects and parses a JSON listing and returns its validators', async () => {
    fetchFileIndex.mockResolvedValueOnce(
      new Response(JSON.stringify({ path: '', files: [{ name: 'a.epub', path: 'S/a.epub', size: 1 }] }), {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT' },
      }),
    );
    const result = await readListing(source(), { signal });
    expect(result).toEqual({
      notModified: false,
      format: 'json',
      pages: 1,
      etag: '"v1"',
      lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT',
      listing: { files: [{ path: 'S/a.epub', name: 'a.epub', size: 1 }], truncated: false },
    });
  });

  it('sends conditional headers for a JSON index and reports an unchanged listing', async () => {
    fetchFileIndex.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const result = await readListing(source({ format: 'json' }), { signal, validators: { etag: '"v1"', lastModified: null } });
    expect(result).toEqual({ notModified: true });
    expect(fetchFileIndex.mock.calls[0]![1].headers['If-None-Match']).toBe('"v1"');
  });

  it('rejects invalid JSON', async () => {
    fetchFileIndex.mockResolvedValueOnce(new Response('{nope', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(readListing(source(), { signal })).rejects.toThrow('not valid JSON');
  });

  it('crawls HTML directory pages breadth first, once each, within the page cap', async () => {
    const pages: Record<string, string> = {
      'https://files.example/books/': '<a href="A/">A/</a><a href="B/">B/</a><a href="root.epub">root</a>',
      'https://files.example/books/A/': '<a href="../">..</a><a href="a1.epub">a1</a><a href="/books/B/">B</a>',
      'https://files.example/books/B/': '<a href="b1.epub">b1</a>',
    };
    fetchFileIndex.mockImplementation((url: string) => Promise.resolve(html(pages[url] ?? '')));

    const result = await readListing(
      source({ listingUrl: 'https://files.example/books/', baseUrl: 'https://files.example/books/', format: 'html' }),
      { signal, pageDelayMs: 0 },
    );

    expect(result.notModified).toBe(false);
    if (result.notModified) return;
    expect(result.pages).toBe(3);
    expect(result.listing.files.map((file) => file.path)).toEqual(['root.epub', 'A/a1.epub', 'B/b1.epub']);
    expect(fetchFileIndex).toHaveBeenCalledTimes(3);

    fetchFileIndex.mockClear();
    const capped = await readListing(
      source({ listingUrl: 'https://files.example/books/', baseUrl: 'https://files.example/books/', format: 'html' }),
      { signal, pageDelayMs: 0, maxPages: 1 },
    );
    expect(capped.notModified === false && capped.listing.truncated).toBe(true);
    expect(fetchFileIndex).toHaveBeenCalledTimes(1);
  });
});
