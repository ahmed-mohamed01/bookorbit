import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditionSyncProvenance, ReadAloudWorkerRequest } from '@bookorbit/types';
import { compareProvenance, isWorkerRebuildValid, matchesRebuildRequest, provenanceFile } from './edition-sync-provenance';
import type { EditionSyncBookFileRef } from './edition-sync.types';

const file = (id: number, format: string): EditionSyncBookFileRef => ({
  id,
  bookId: 7,
  absolutePath: `/books/${id}.${format}`,
  format,
  role: 'content',
  sizeBytes: 100,
  fileHash: 'hash',
  mtime: new Date(1000),
  durationSeconds: null,
  mediaOverlayAvailable: false,
});
const epub = file(1, 'epub');
const audio = file(2, 'mp3');
const provenance = {
  bookId: 7,
  epub: provenanceFile(epub),
  audio: [{ ...provenanceFile(audio), order: 0 }],
  language: 'en',
  granularity: 'sentence',
  model: 'quartznet15x5',
  decisions: { chapters: {}, audio: [] },
} as unknown as EditionSyncProvenance;
const request = {
  epubPath: epub.absolutePath,
  audioPaths: [audio.absolutePath],
  language: 'en',
  granularity: 'sentence',
  model: 'quartznet15x5',
  decisions: { chapters: {}, audio: [] },
} as unknown as ReadAloudWorkerRequest;

describe('edition sync provenance', () => {
  it('permits renames with unchanged fingerprints', () => {
    expect(compareProvenance(provenance, [{ ...epub, absolutePath: '/moved/book.epub' }, audio])).toEqual({ valid: true });
  });
  it('detects EPUB, audio and missing-file changes', () => {
    expect(compareProvenance(provenance, [{ ...epub, fileHash: 'new' }, audio])).toEqual({ valid: false, reason: 'epub_changed' });
    expect(compareProvenance(provenance, [epub, { ...audio, sizeBytes: 99 }])).toEqual({ valid: false, reason: 'audio_changed' });
    expect(compareProvenance(provenance, [epub])).toEqual({ valid: false, reason: 'file_missing' });
    expect(compareProvenance(provenance, [epub, { ...audio, bookId: 8 }])).toEqual({ valid: false, reason: 'file_missing' });
  });
  it('detects mtime changes even when size and hash agree', () => {
    expect(compareProvenance(provenance, [epub, { ...audio, mtime: new Date(2000) }])).toEqual({ valid: false, reason: 'audio_changed' });
  });
  it('uses mtime when a content hash is unavailable', () => {
    const unhashed = { ...audio, fileHash: null };
    const stored = { ...provenance, audio: [{ ...provenanceFile(unhashed), order: 0 }] };
    expect(compareProvenance(stored, [epub, { ...unhashed, mtime: new Date(2000) }])).toEqual({ valid: false, reason: 'audio_changed' });
  });
  it('requires the exact source order, language, granularity and empty decisions', () => {
    expect(matchesRebuildRequest(provenance, request, [epub, audio])).toBe(true);
    for (const patch of [
      { language: 'fr' },
      { granularity: 'word' as const },
      { audioPaths: ['/other.mp3'] },
      { decisions: { chapters: { 'a.xhtml': 'excluded' as const }, audio: [] } },
    ])
      expect(matchesRebuildRequest(provenance, { ...request, ...patch }, [epub, audio])).toBe(false);
  });
  it('accepts only rebuild requests the worker would validate', () => {
    const chunk = { name: '00001.mp3', size: 5, sha256: 'a'.repeat(64) };
    const rebuild = {
      indexEntry: 'index.epub',
      reportEntry: 'bookorbit-timings/report.json',
      chunks: [chunk],
      audioEntries: [{ href: 'OPS/a.mp3', chunk: chunk.name }],
    };
    expect(isWorkerRebuildValid(rebuild)).toBe(true);
    const source = { href: 'OPS/image.png', size: 5, crc32: 0xffffffff };
    expect(isWorkerRebuildValid({ ...rebuild, sourceEntries: [source] })).toBe(true);
    const variants = [
      undefined,
      [],
      [source],
      [source, source],
      ...['../x', 'mimetype', 'bookorbit-timings/x', 'OPS/a.mp3'].map((href) => [{ ...source, href }]),
      ...[-1, 1.5, 0x100000000].map((crc32) => [{ ...source, crc32 }]),
      ...[0, 7, -1, 1.5].map((position) => [{ ...source, position }]),
    ];
    const requests = [
      { ...rebuild, textFingerprint: { obsolete: true } },
      ...variants.map((sourceEntries) => ({ ...rebuild, sourceEntries })),
      ...['a'.repeat(32), 'BAD', '', 'b'.repeat(64), ['a'.repeat(32)] as never].map((audioMd5) => ({ ...rebuild, chunks: [{ ...chunk, audioMd5 }] })),
      ...['a'.repeat(64), 'BAD', '', 'b'.repeat(32), ['a'.repeat(64)] as never].map((chapterFingerprint) => ({ ...rebuild, chapterFingerprint })),
    ];
    const workerResults = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import ts from 'typescript';
      import { createRequire } from 'node:module';
      const sourcePath = ${JSON.stringify(resolve('../workers/read-aloud/src/validation.ts'))};
      const workerRequire = createRequire(sourcePath);
      const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      const workerExports = {};
      new Function('require', 'exports', compiled)((name) => name === './paths.js' ? { RequestError: Error } : workerRequire(name), workerExports);
      const { validateRequest } = workerExports;
      import { readFileSync } from 'node:fs';
      const results = JSON.parse(readFileSync(0, 'utf8')).map(rebuild => {
        try { validateRequest({ jobId: '11111111-1111-1111-1111-111111111111', epubPath: '/book', audioPaths: ['/audio'], workDir: '/work', language: 'en', granularity: 'sentence', model: 'quartznet15x5', sourceBytes: 0, maxOutputBytes: 100, rebuild }); return true; } catch { return false; }
      });
      process.stdout.write(JSON.stringify(results));
    `,
        ],
        { input: JSON.stringify(requests), encoding: 'utf8' },
      ),
    ) as boolean[];
    expect(workerResults).toEqual(requests.map(isWorkerRebuildValid));

    for (const sourceEntries of [
      ...['../image.png', 'mimetype', 'bookorbit-timings/image.png', 'OPS/a.mp3', 'OPS/./image.png'].map((href) => [{ ...source, href }]),
      [source, source],
      [{ ...source, size: -1 }],
      [{ ...source, size: 1.5 }],
      [{ ...source, crc32: -1 }],
      [{ ...source, crc32: 0x100000000 }],
      [{ ...source, crc32: 1.5 }],
      [{ ...source, position: -1 }],
      [{ ...source, position: 1.5 }],
      Array(10001).fill(source),
    ])
      expect(isWorkerRebuildValid({ ...rebuild, sourceEntries })).toBe(false);
    for (const bad of [
      { ...rebuild, chunks: [] },
      { ...rebuild, chunks: [{ ...chunk, name: 'dir/00001.mp3' }] },
      { ...rebuild, chunks: [{ ...chunk, sha256: 'bad' }] },
      { ...rebuild, audioEntries: [] },
      { ...rebuild, audioEntries: [{ href: 'mimetype', chunk: chunk.name }] },
      { ...rebuild, audioEntries: [{ href: 'bookorbit-timings/a.mp3', chunk: chunk.name }] },
      { ...rebuild, audioEntries: [{ href: 'OPS/./a.mp3', chunk: chunk.name }] },
      { ...rebuild, audioEntries: [{ href: 'OPS/a:b.mp3', chunk: chunk.name }] },
      { ...rebuild, audioEntries: [{ href: 'OPS/a.mp3', chunk: 'missing' }] },
      { ...rebuild, audioEntries: [rebuild.audioEntries[0]!, rebuild.audioEntries[0]!] },
    ])
      expect(isWorkerRebuildValid(bad)).toBe(false);
  });
});
