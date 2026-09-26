import { describe, expect, it } from 'vitest';

import {
  normalizeBook,
  normalizeProgress,
  normalizeStorytellerIdentifier,
  readAligned,
  readBookList,
  readCapabilityKeys,
  readCapabilityList,
} from './storyteller-book-normalize.utils';

describe('normalizeBook', () => {
  it('reports the read-along path only when the read-along is finished', () => {
    const done = normalizeBook({ uuid: 'b', readaloud: { status: 'ALIGNED', filepath: '/data/assets/b/aligned/b.epub' } });
    const midway = normalizeBook({ uuid: 'b', readaloud: { status: 'PROCESSING', filepath: '/data/assets/b/aligned/b.epub' } });

    expect(done?.readaloudPath).toBe('/data/assets/b/aligned/b.epub');
    // A path on a processing row points at a half-written file, not a result.
    expect(midway?.readaloudPath).toBeNull();
  });

  it('reads the current v2 shape', () => {
    const book = normalizeBook({
      uuid: 'book-1',
      title: 'Foundation',
      authors: [{ name: 'Isaac Asimov', role: 'aut' }],
      identifiers: [{ kind: 'isbn', value: '978-0-553-29335-7' }],
      ebook: { filepath: '/library/Foundation.epub', missing: 0 },
      audiobook: { filepath: '/library/Foundation/01.mp3', missing: 0 },
      readaloud: { filepath: '/library/Foundation.epub', status: 'ALIGNED', currentStage: 'SYNC_CHAPTERS', stageProgress: 1 },
      processingJob: { status: 'RUNNING', stage: 'TRANSCRIBE_CHAPTERS', progress: 0.42 },
    });

    expect(book).toEqual({
      uuid: 'book-1',
      title: 'Foundation',
      authors: ['Isaac Asimov'],
      identifiers: ['9780553293357'],
      aligned: true,
      hasEbook: true,
      hasAudiobook: true,
      readaloudPath: '/library/Foundation.epub',
      processing: { state: 'running', task: 'TRANSCRIBE_CHAPTERS', progress: 0.42, error: null },
    });
  });

  it('reads the older snake_case shape and percent progress', () => {
    const book = normalizeBook({
      uuid: 'book-2',
      title: 'Nightfall',
      authors: ['Isaac Asimov'],
      isbn: '9780553290998',
      processing_status: { current_task: 'SYNC_CHAPTERS', progress: 45, status: 'STARTED' },
    });

    expect(book?.processing).toEqual({ state: 'running', task: 'SYNC_CHAPTERS', progress: 0.45, error: null });
    expect(book?.identifiers).toEqual(['9780553290998']);
    expect(book?.aligned).toBe(false);
  });

  it('reads an error flag as a failed job', () => {
    const book = normalizeBook({ uuid: 'book-3', processing_status: { current_task: 'TRANSCRIBE_CHAPTERS', progress: 0.1, in_error: true } });

    expect(book?.processing.state).toBe('failed');
  });

  it('falls back to unknown for a shape it does not recognize', () => {
    const book = normalizeBook({ uuid: 'book-4', title: 'Mystery', stateOfMind: 'serene' });

    expect(book?.processing).toEqual({ state: 'unknown', task: null, progress: null, error: null });
    expect(book?.aligned).toBe(false);
  });

  it('reads authors from creators when there is no author list', () => {
    const book = normalizeBook({
      uuid: 'book-6',
      creators: [
        { name: 'Isaac Asimov', role: 'aut' },
        { name: 'Scott Brick', role: 'nrt' },
      ],
    });

    expect(book?.authors).toEqual(['Isaac Asimov']);
  });

  it('reads identifiers from a map and drops duplicates', () => {
    const book = normalizeBook({ uuid: 'book-7', identifiers: { isbn: '978-0-553-29335-7', asin: 'B00X57B4KG' }, isbn13: '9780553293357' });

    expect(book?.identifiers).toEqual(['9780553293357', 'b00x57b4kg']);
  });

  // The build service waits two minutes on these two flags before it starts processing, so a
  // linked-but-unusable file has to read as false and a real link has to read as true.
  it('reads a linked ebook and audiobook as present', () => {
    const book = normalizeBook({
      uuid: 'book-9',
      ebook: { filepath: '/library/Foundation.epub', missing: 0 },
      audiobook: { filepath: '/library/Foundation/01.mp3', missing: 0 },
    });

    expect(book?.hasEbook).toBe(true);
    expect(book?.hasAudiobook).toBe(true);
  });

  it('reads an audiobook linked under the legacy audio key', () => {
    const book = normalizeBook({ uuid: 'book-10', audio: { filepath: '/library/Foundation/01.mp3', missing: 0 } });

    expect(book?.hasAudiobook).toBe(true);
  });

  it('refuses a link flagged missing, whether the flag is a number or a boolean', () => {
    const numeric = normalizeBook({
      uuid: 'book-11',
      ebook: { filepath: '/library/Foundation.epub', missing: 1 },
      audiobook: { filepath: '/library/Foundation/01.mp3', missing: 1 },
    });
    const boolish = normalizeBook({
      uuid: 'book-12',
      ebook: { filepath: '/library/Foundation.epub', missing: true },
      audiobook: { filepath: '/library/Foundation/01.mp3', missing: true },
    });

    expect([numeric?.hasEbook, numeric?.hasAudiobook]).toEqual([false, false]);
    expect([boolish?.hasEbook, boolish?.hasAudiobook]).toEqual([false, false]);
  });

  it('refuses a link with no filepath and a book with no links at all', () => {
    const pathless = normalizeBook({ uuid: 'book-13', ebook: { missing: 0 }, audiobook: { missing: 0 } });
    const bare = normalizeBook({ uuid: 'book-14', title: 'Nothing scanned yet' });

    expect([pathless?.hasEbook, pathless?.hasAudiobook]).toEqual([false, false]);
    expect([bare?.hasEbook, bare?.hasAudiobook]).toEqual([false, false]);
  });

  it('unwraps a book envelope and refuses a payload without a uuid', () => {
    expect(normalizeBook({ book: { uuid: 'book-8', title: 'Wrapped' } })?.uuid).toBe('book-8');
    expect(normalizeBook({ title: 'No uuid' })).toBeNull();
    expect(normalizeBook('nonsense')).toBeNull();
  });
});

describe('readAligned', () => {
  it('trusts an ALIGNED read-along relation', () => {
    expect(readAligned({ readaloud: { status: 'ALIGNED', filepath: '/library/Foundation.epub' } })).toBe(true);
    expect(readAligned({ readaloud: { status: 'ALIGNED' } })).toBe(true);
  });

  it('refuses a half-written file on every other known status', () => {
    for (const status of ['CREATED', 'QUEUED', 'PROCESSING', 'STOPPED', 'ERROR']) {
      expect(readAligned({ readaloud: { status, filepath: '/library/Foundation.epub' } })).toBe(false);
    }
  });

  it('accepts a filepath only when there is no status to read', () => {
    expect(readAligned({ readaloud: { filepath: '/library/Foundation.epub' } })).toBe(true);
    expect(readAligned({ readaloud: { status: 'WAT', filepath: '/library/Foundation.epub' } })).toBe(true);
    expect(readAligned({ readaloud: {} })).toBe(false);
  });

  it('does not treat a completed processing job as a read-along', () => {
    expect(readAligned({ processingStatus: { status: 'COMPLETED' } })).toBe(false);
    expect(normalizeBook({ uuid: 'book-5', processingStatus: { status: 'COMPLETED' } })?.aligned).toBe(false);
  });

  it('still honours an explicit flag', () => {
    expect(readAligned({ aligned: true })).toBe(true);
    expect(readAligned({ mediaOverlay: true })).toBe(true);
    expect(readAligned({ aligned: false, readaloud: { status: 'ALIGNED' } })).toBe(true);
  });
});

describe('readBookList', () => {
  it('reads a bare array, a books envelope and drops unusable entries', () => {
    expect(readBookList([{ uuid: 'book-1' }, { title: 'no uuid' }]).map((book) => book.uuid)).toEqual(['book-1']);
    expect(readBookList({ books: [{ uuid: 'book-2' }] }).map((book) => book.uuid)).toEqual(['book-2']);
    expect(readBookList(null)).toEqual([]);
  });
});

describe('capabilities', () => {
  it('reads a declared list and a feature map', () => {
    expect(readCapabilityList({ capabilities: ['opds', 'book-upload'] })).toEqual(['opds', 'book-upload']);
    expect(readCapabilityList({ capabilities: { opds: true, tts: false } })).toEqual(['opds']);
    expect(readCapabilityKeys({ ctcDevices: { available: [] }, missing: null })).toEqual(['ctcDevices']);
  });
});

describe('normalizeProgress', () => {
  it('normalizes fractions, percentages and nonsense', () => {
    expect(normalizeProgress(0.42)).toBe(0.42);
    expect(normalizeProgress(45)).toBe(0.45);
    expect(normalizeProgress(180)).toBe(1);
    expect(normalizeProgress(-1)).toBeNull();
    expect(normalizeProgress(null)).toBeNull();
  });
});

describe('normalizeStorytellerIdentifier', () => {
  it('strips separators and case', () => {
    expect(normalizeStorytellerIdentifier('978-0-553-29335-7')).toBe('9780553293357');
    expect(normalizeStorytellerIdentifier(' B00X57B4KG ')).toBe('b00x57b4kg');
  });

  it('returns null for values with nothing comparable left', () => {
    expect(normalizeStorytellerIdentifier('---')).toBeNull();
    expect(normalizeStorytellerIdentifier(null)).toBeNull();
  });
});
