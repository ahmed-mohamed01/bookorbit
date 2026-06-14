import { MetadataProviderKey } from '@bookorbit/types';

import { mapGoodreadsApolloState, mapGoodreadsAutocompleteItem } from './goodreads.mapper';

describe('GoodreadsMapper', () => {
  it('should map a complete Goodreads apollo state correctly', () => {
    const bookId = '12345';
    const mockState: Record<string, any> = {
      'Book:kca:123': {
        title: 'The Great Gatsby: A Classic Novel',
        description: 'A story about Jay Gatsby.',
        imageUrl: 'https://images.gr-assets.com/books/123.jpg',
        primaryContributorEdge: {
          node: { __ref: 'Contributor:kca:456' },
        },
        bookGenres: [{ genre: { name: 'Fiction' } }, { genre: { name: 'Classics' } }],
        details: {
          publicationTime: 123456789000, // 1973
          numPages: 180,
          publisher: 'Scribner',
          language: { name: 'English' },
          isbn: '1234567890',
          isbn13: '1234567890123',
        },
        bookSeries: [{ userPosition: '1' }],
      },
      'Contributor:kca:456': {
        name: 'F. Scott Fitzgerald',
      },
      'Series:kca:789': {
        title: 'Great American Novels',
      },
    };

    const result = mapGoodreadsApolloState(mockState, bookId);

    expect(result).toEqual({
      provider: MetadataProviderKey.GOODREADS,
      providerId: bookId,
      title: 'The Great Gatsby',
      subtitle: 'A Classic Novel',
      authors: ['F. Scott Fitzgerald'],
      description: 'A story about Jay Gatsby.',
      publisher: 'Scribner',
      publishedYear: 1973,
      language: 'English',
      pageCount: 180,
      isbn10: '1234567890',
      isbn13: '1234567890123',
      genres: ['Fiction', 'Classics'],
      coverUrl: 'https://images.gr-assets.com/books/123.jpg',
      sourceUrl: `https://www.goodreads.com/book/show/${bookId}`,
      seriesName: 'Great American Novels',
      seriesIndex: 1,
    });
  });

  it('should return null if book not found in state', () => {
    const result = mapGoodreadsApolloState({}, '12345');
    expect(result).toBeNull();
  });

  it('should handle title without subtitle', () => {
    const mockState = {
      'Book:kca:1': { title: 'Simple Title' },
    };
    const result = mapGoodreadsApolloState(mockState, '1');
    expect(result?.title).toBe('Simple Title');
    expect(result?.subtitle).toBeUndefined();
  });

  it('should handle missing optional fields', () => {
    const mockState = {
      'Book:kca:1': { title: 'Minimal' },
    };
    const result = mapGoodreadsApolloState(mockState, '1');
    expect(result).toMatchObject({
      title: 'Minimal',
      providerId: '1',
    });
    expect(result?.authors).toBeUndefined();
    expect(result?.publishedYear).toBeUndefined();
  });

  it('should fallback to findContributorWithName if primaryContributorEdge is missing', () => {
    const mockState = {
      'Book:kca:1': { title: 'Test Book' },
      'Contributor:kca:123': { name: 'Implicit Author' },
    };
    const result = mapGoodreadsApolloState(mockState, '1');
    expect(result?.authors).toEqual(['Implicit Author']);
  });

  it('should normalize "null" strings to undefined', () => {
    const mockState = {
      'Book:kca:1': {
        title: 'Test Book',
        description: 'null',
        details: {
          publisher: 'null',
          isbn: 'null',
        },
      },
    };
    const result = mapGoodreadsApolloState(mockState, '1');
    expect(result?.description).toBeUndefined();
    expect(result?.publisher).toBeUndefined();
    expect(result?.isbn10).toBeUndefined();
  });

  it('prefers exact book key for the requested bookId when multiple book entries exist', () => {
    const mockState = {
      'Book:kca:111': { title: 'Wrong Book' },
      'Book:kca:222': { title: 'Right Book' },
      'Contributor:kca:200': { name: 'Author Two' },
    };

    const result = mapGoodreadsApolloState(mockState, '222');

    expect(result?.title).toBe('Right Book');
  });

  it('selects the live Goodreads legacyId match when a stub book appears first', () => {
    const mockState = {
      'Book:kca://book/amzn1.gr.book.v3.stub': {
        legacyId: 56916837,
        webUrl: 'https://www.goodreads.com/book/show/56916837-to-kill-a-mockingbird',
      },
      'Book:kca://book/amzn1.gr.book.v1.full': {
        legacyId: 2657,
        title: 'To Kill a Mockingbird',
        description: 'A novel about Scout Finch.',
        imageUrl: 'https://images.gr-assets.com/books/2657.jpg',
        primaryContributorEdge: {
          node: { __ref: 'Contributor:kca://author/harper-lee' },
        },
        bookGenres: [{ genre: { name: 'Classics' } }],
        details: {
          publicationTime: 1148367600000,
          numPages: 323,
          publisher: 'Harper Perennial Modern Classics',
          language: { name: 'English' },
          isbn: '0060935464',
          isbn13: '9780060935467',
        },
      },
      'Contributor:kca://author/harper-lee': {
        name: 'Harper Lee',
      },
    };

    const result = mapGoodreadsApolloState(mockState, '2657');

    expect(result).toMatchObject({
      providerId: '2657',
      title: 'To Kill a Mockingbird',
      authors: ['Harper Lee'],
      description: 'A novel about Scout Finch.',
      publisher: 'Harper Perennial Modern Classics',
      pageCount: 323,
      isbn13: '9780060935467',
      genres: ['Classics'],
      coverUrl: 'https://images.gr-assets.com/books/2657.jpg',
    });
  });

  describe('mapGoodreadsAutocompleteItem', () => {
    it('maps a full autocomplete item, splitting subtitle and parsing series from the title', () => {
      const result = mapGoodreadsAutocompleteItem(
        {
          bookId: '68428',
          title: 'Mistborn: The Final Empire (Mistborn, #1)',
          bookTitleBare: 'Mistborn: The Final Empire',
          author: { name: 'Brandon Sanderson' },
          numPages: 541,
          imageUrl: 'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1617768316i/68428._SY75_.jpg',
          description: { html: 'For a thousand years the ash fell &amp; no flowers bloomed.<br/><br/>Once, a hero rose…', truncated: true },
        },
        '68428',
      );

      expect(result).toEqual({
        provider: MetadataProviderKey.GOODREADS,
        providerId: '68428',
        title: 'Mistborn',
        subtitle: 'The Final Empire',
        authors: ['Brandon Sanderson'],
        description: 'For a thousand years the ash fell & no flowers bloomed.\n\nOnce, a hero rose…',
        pageCount: 541,
        coverUrl: 'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1617768316i/68428.jpg',
        sourceUrl: 'https://www.goodreads.com/book/show/68428',
        seriesName: 'Mistborn',
        seriesIndex: 1,
      });
    });

    it('derives the bookId from bookUrl and accepts a string author', () => {
      const result = mapGoodreadsAutocompleteItem(
        { bookUrl: '/book/show/54493401-project-hail-mary', title: 'Project Hail Mary', author: 'Andy Weir', numPages: 476 },
        '54493401',
      );

      expect(result).toMatchObject({ title: 'Project Hail Mary', authors: ['Andy Weir'], pageCount: 476 });
      expect(result?.subtitle).toBeUndefined();
      expect(result?.seriesName).toBeUndefined();
      expect(result?.seriesIndex).toBeUndefined();
    });

    it('returns null when the item has no usable title', () => {
      expect(mapGoodreadsAutocompleteItem({ bookId: '1', numPages: 10 }, '1')).toBeNull();
    });

    it('ignores a zero page count and a missing cover', () => {
      const result = mapGoodreadsAutocompleteItem({ bookTitleBare: 'Untitled', numPages: 0 }, '7');
      expect(result?.pageCount).toBeUndefined();
      expect(result?.coverUrl).toBeUndefined();
    });
  });

  it('falls back to the richest titled book when the requested legacyId is an untitled stub', () => {
    const mockState = {
      'Book:kca://book/amzn1.gr.book.v3.stub': {
        legacyId: 56916837,
        webUrl: 'https://www.goodreads.com/book/show/56916837-to-kill-a-mockingbird',
      },
      'Book:kca://book/amzn1.gr.book.v1.full': {
        legacyId: 2657,
        title: 'To Kill a Mockingbird',
        description: 'A novel about Scout Finch.',
        imageUrl: 'https://images.gr-assets.com/books/2657.jpg',
        details: {
          numPages: 323,
        },
      },
    };

    const result = mapGoodreadsApolloState(mockState, '56916837');

    expect(result?.providerId).toBe('56916837');
    expect(result?.title).toBe('To Kill a Mockingbird');
    expect(result?.description).toBe('A novel about Scout Finch.');
    expect(result?.pageCount).toBe(323);
  });
});
