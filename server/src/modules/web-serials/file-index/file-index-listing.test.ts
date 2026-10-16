import { describe, expect, it } from 'vitest';

import { LISTING_MAX_DEPTH, listingFileUrl, parseHtmlListingPage, parseJsonListing, relativeListingPath } from './file-index-listing';

describe('parseJsonListing', () => {
  it('reads files from a nested name/path/folders/files tree', () => {
    const body = {
      name: 'root',
      path: '',
      folders: [
        {
          name: 'S',
          path: '!Yaoi/S',
          folders: [],
          files: [
            {
              name: 'S - Volume 01 - Spy Sensation [June][Kindle].epub',
              path: '!Yaoi/S/S - Volume 01 - Spy Sensation [June][Kindle].epub',
              size: 2866140,
            },
            { name: 'S - Volume 01 [Kindle].pdf', path: '!Yaoi/S/S - Volume 01 [Kindle].pdf', size: '4708020' },
          ],
        },
      ],
      files: [{ name: 'index.json', path: 'index.json', size: 1 }],
    };

    expect(parseJsonListing(body)).toEqual({
      truncated: false,
      files: [
        { path: 'index.json', name: 'index.json', size: 1 },
        {
          path: '!Yaoi/S/S - Volume 01 - Spy Sensation [June][Kindle].epub',
          name: 'S - Volume 01 - Spy Sensation [June][Kindle].epub',
          size: 2866140,
        },
        { path: '!Yaoi/S/S - Volume 01 [Kindle].pdf', name: 'S - Volume 01 [Kindle].pdf', size: 4708020 },
      ],
    });
  });

  it('builds paths from names when nodes carry none, and honours a key map', () => {
    const body = [{ title: 'Books', dirs: [{ title: 'Series A', items: [{ title: 'Vol 1.epub', bytes: 10 }] }] }];
    const listing = parseJsonListing(body, { name: 'title', folders: 'dirs', files: 'items', size: 'bytes' });
    expect(listing.files).toEqual([{ path: 'Books/Series A/Vol 1.epub', name: 'Vol 1.epub', size: 10 }]);
  });

  it('drops paths that climb out of the base and ignores malformed nodes', () => {
    const body = {
      files: [
        { name: 'a.epub', path: '../secret/a.epub' },
        { name: 'b.epub', path: 'ok/./b.epub' },
        'not a node',
        { path: 'C:\\books\\c.epub' },
        { name: 'd.epub', path: '/abs/d.epub', size: -1 },
      ],
      folders: 'nope',
    };
    expect(parseJsonListing(body).files).toEqual([
      { path: 'C:/books/c.epub', name: 'c.epub', size: null },
      { path: 'abs/d.epub', name: 'd.epub', size: null },
    ]);
  });

  it('stops at the depth limit without recursing', () => {
    let node: Record<string, unknown> = { name: 'leaf', files: [{ name: 'deep.epub' }] };
    for (let depth = 0; depth < LISTING_MAX_DEPTH + 5; depth += 1) node = { name: `d${depth}`, folders: [node] };
    const listing = parseJsonListing(node);
    expect(listing.truncated).toBe(true);
    expect(listing.files).toEqual([]);
  });
});

describe('parseHtmlListingPage', () => {
  it('keeps only links below the page from an nginx autoindex', () => {
    const html = `<html><body><h1>Index of /books/</h1><pre>
<a href="../">../</a>
<a href="Series%20A/">Series A/</a>
<a href="?C=N;O=D">Name</a>
<a href="https://other.example/x.epub">elsewhere</a>
<a href="Lone%20Book%20%231.epub">Lone Book #1.epub</a>
<a href='/books/Series%20B/'>Series B/</a>
<a href="#top">top</a>
</pre></body></html>`;
    expect(parseHtmlListingPage(html, 'https://files.example/books/')).toEqual({
      folders: ['https://files.example/books/Series%20A/', 'https://files.example/books/Series%20B/'],
      files: [{ url: 'https://files.example/books/Lone%20Book%20%231.epub', name: 'Lone Book #1.epub' }],
    });
  });

  it('treats a page URL without a trailing slash as a directory', () => {
    const page = parseHtmlListingPage('<a href="x.epub">x</a>', 'https://files.example/books');
    expect(page.files).toEqual([{ url: 'https://files.example/books/x.epub', name: 'x.epub' }]);
  });
});

describe('listing paths and URLs', () => {
  it('round-trips names with reserved characters', () => {
    const url = listingFileUrl('https://files.example/books', 'Series #1/Vol 1 [100%].epub');
    expect(url).toBe('https://files.example/books/Series%20%231/Vol%201%20%5B100%25%5D.epub');
    expect(relativeListingPath(url, 'https://files.example/books/')).toBe('Series #1/Vol 1 [100%].epub');
  });

  it('refuses a URL outside the base', () => {
    expect(relativeListingPath('https://files.example/other/x.epub', 'https://files.example/books/')).toBeNull();
  });
});
