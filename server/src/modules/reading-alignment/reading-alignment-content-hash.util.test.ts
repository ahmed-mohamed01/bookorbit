import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import { audioContentHashOf, contentHashesDiffer, epubContentHashOf } from './reading-alignment-content-hash.util';

const EBOOK = { id: 5, absolutePath: '/books/x.epub', sizeBytes: 1000 };
const AUDIO_FILES = [
  { fileId: 9, absolutePath: '/books/x-1.mp3', durationSeconds: 40 },
  { fileId: 10, absolutePath: '/books/x-2.mp3', durationSeconds: 60 },
];

function sha256Json(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

describe('audioContentHashOf', () => {
  it('matches the persisted hash format', () => {
    expect(audioContentHashOf(AUDIO_FILES)).toBe(
      sha256Json([
        [9, '/books/x-1.mp3', 40],
        [10, '/books/x-2.mp3', 60],
      ]),
    );
  });

  it('is deterministic', () => {
    expect(audioContentHashOf(AUDIO_FILES)).toBe(audioContentHashOf(AUDIO_FILES.map((f) => ({ ...f }))));
  });

  it('is sensitive to file order', () => {
    expect(audioContentHashOf([...AUDIO_FILES].reverse())).not.toBe(audioContentHashOf(AUDIO_FILES));
  });

  it('changes when a duration changes', () => {
    const changed = [AUDIO_FILES[0], { ...AUDIO_FILES[1], durationSeconds: 61 }];
    expect(audioContentHashOf(changed)).not.toBe(audioContentHashOf(AUDIO_FILES));
  });

  it('ignores fields outside the hash inputs', () => {
    const withExtra = AUDIO_FILES.map((f) => ({ ...f, sortOrder: 3 }));
    expect(audioContentHashOf(withExtra)).toBe(audioContentHashOf(AUDIO_FILES));
  });
});

describe('epubContentHashOf', () => {
  it('matches the persisted hash format', () => {
    expect(epubContentHashOf(EBOOK)).toBe(sha256Json([5, '/books/x.epub', 1000]));
  });

  it('is deterministic', () => {
    expect(epubContentHashOf(EBOOK)).toBe(epubContentHashOf({ ...EBOOK }));
  });

  it('changes when the size changes', () => {
    expect(epubContentHashOf({ ...EBOOK, sizeBytes: 1001 })).not.toBe(epubContentHashOf(EBOOK));
  });
});

describe('contentHashesDiffer', () => {
  const stored = { audioContentHash: audioContentHashOf(AUDIO_FILES), epubContentHash: epubContentHashOf(EBOOK) };

  it('is false when both hashes match', () => {
    expect(contentHashesDiffer(stored, EBOOK, AUDIO_FILES)).toBe(false);
  });

  it('is true when the audio hash differs', () => {
    expect(contentHashesDiffer({ ...stored, audioContentHash: 'old' }, EBOOK, AUDIO_FILES)).toBe(true);
  });

  it('is true when the epub hash differs', () => {
    expect(contentHashesDiffer({ ...stored, epubContentHash: null }, EBOOK, AUDIO_FILES)).toBe(true);
  });

  it('is true when the ebook or audio files are missing', () => {
    expect(contentHashesDiffer(stored, undefined, AUDIO_FILES)).toBe(true);
    expect(contentHashesDiffer(stored, EBOOK, [])).toBe(true);
  });
});
