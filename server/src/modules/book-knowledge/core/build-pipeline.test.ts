import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArtifactInProcess } from './build-pipeline';
import { readArtifact } from './artifact';

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
});
