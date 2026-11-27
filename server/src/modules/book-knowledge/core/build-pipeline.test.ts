import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArtifactInProcess, unusableStage } from './build-pipeline';
import { ArtifactReadLimitError, readArtifact } from './artifact';

const stage = vi.hoisted(() => ({ buildKindSpans: vi.fn() }));
vi.mock('../gliner/stage', () => stage);

async function epub(): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    'META-INF/container.xml',
    new TextReader('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),
  );
  await writer.add(
    'EPUB/package.opf',
    new TextReader(
      '<package><manifest><item id="c0" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>',
    ),
  );
  await writer.add('EPUB/one.xhtml', new TextReader('<html><body><p>The amber lattice hums. The amber lattice glows.</p></body></html>'));
  return Buffer.from(await writer.close());
}

describe('artifact build pipeline', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'knowledge-pipeline-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('stores empty model votes when GLiNER passes its deadline, so the book is not rebuilt for votes', async () => {
    stage.buildKindSpans.mockResolvedValue({ reused: false, timedOut: true });
    const path = join(directory, 'book.epub');
    await writeFile(path, await epub());
    const outputPath = join(directory, 'artifact.json.gz');
    const result = await buildArtifactInProcess(path, { outputPath, gliner: { directory } });
    expect(result.artifact.modelVotes).toEqual([]);
    expect(result.artifact.spineBytes).toHaveLength(1);
    const stored = await readArtifact(outputPath);
    expect(stored.modelVotes).toEqual([]);
    expect(result.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(result.artifact)));
  });

  it('rebuilds a damaged stage cache instead of failing every retry', async () => {
    const path = join(directory, 'book.epub');
    await writeFile(path, await epub());
    const fingerprint = 'a'.repeat(64);
    const cacheDirectory = join(directory, 'cache');
    const first = await buildArtifactInProcess(path, { fingerprint, cacheDirectory });
    const stageDirectory = join(cacheDirectory, fingerprint);
    const [termsStage, textStage] = (await readdir(stageDirectory)).sort();
    await writeFile(join(stageDirectory, textStage), 'not gzip at all');
    await writeFile(join(stageDirectory, termsStage), gzipSync('{"terms": ['));
    const second = await buildArtifactInProcess(path, { fingerprint, cacheDirectory });
    expect(second.reused).toMatchObject({ text: false, terms: false });
    expect(second.artifact.terms).toEqual(first.artifact.terms);
    const third = await buildArtifactInProcess(path, { fingerprint, cacheDirectory });
    expect(third.reused).toMatchObject({ text: true, terms: true });
  });

  it('still fails on a stage cache the disk cannot read', async () => {
    const path = join(directory, 'book.epub');
    await writeFile(path, await epub());
    const fingerprint = 'b'.repeat(64);
    const cacheDirectory = join(directory, 'cache');
    await buildArtifactInProcess(path, { fingerprint, cacheDirectory });
    const stageDirectory = join(cacheDirectory, fingerprint);
    const [termsStage] = (await readdir(stageDirectory)).sort();
    await rm(join(stageDirectory, termsStage));
    await mkdir(join(stageDirectory, termsStage));
    await expect(buildArtifactInProcess(path, { fingerprint, cacheDirectory })).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('treats only missing, damaged or oversized stage files as a cache miss', () => {
    expect(unusableStage(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true);
    expect(unusableStage(Object.assign(new Error('bad header'), { code: 'Z_DATA_ERROR' }))).toBe(true);
    expect(unusableStage(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    expect(unusableStage(new ArtifactReadLimitError())).toBe(true);
    expect(unusableStage(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
  });
});
