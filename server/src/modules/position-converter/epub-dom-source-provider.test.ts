import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EpubDomSourceResolver } from './epub-dom-source-provider';
import { EpubDomService } from './epub-dom.service';

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title><dc:identifier id="uid">x</dc:identifier></metadata>
  <manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body><p id="s1">Indexed text.</p></body></html>`;

async function buildZip(path: string): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  archive.append('application/epub+zip', { name: 'mimetype', store: true });
  archive.append(CONTAINER_XML, { name: 'META-INF/container.xml' });
  archive.append(CONTENT_OPF, { name: 'OEBPS/content.opf' });
  archive.append(CH1, { name: 'OEBPS/text/ch1.xhtml' });
  await archive.finalize();
  await done;
  await writeFile(path, Buffer.concat(chunks));
}

function makeDb(absolutePath: string, format: string) {
  const limit = vi.fn().mockResolvedValue([{ absolutePath, format }]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { select: vi.fn().mockReturnValue({ from }) };
}

describe('EPUB DOM source resolver seam', () => {
  let dir: string;
  let indexPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-epub-source-'));
    indexPath = join(dir, 'book.bookorbit-timings');
    await buildZip(indexPath);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a non-EPUB row when no resolver is registered', async () => {
    const service = new EpubDomService(makeDb(indexPath, 'bookorbit-timings') as never);
    await expect(service.getSpineHrefs(40)).resolves.toBeNull();
  });

  it('reads a non-EPUB row through the EPUB the resolver maps it to', async () => {
    const resolver: EpubDomSourceResolver = { resolveEpubDomSource: vi.fn().mockResolvedValue({ absolutePath: indexPath, format: 'epub' }) };
    const service = new EpubDomService(makeDb(indexPath, 'bookorbit-timings') as never, resolver);

    await expect(service.getSpineHrefs(40)).resolves.toEqual(['OEBPS/text/ch1.xhtml']);
    expect((await service.getChapter(40, 0))?.index.collapsed).toBe('Indexed text.');
    expect(resolver.resolveEpubDomSource).toHaveBeenCalledWith(40, { absolutePath: indexPath, format: 'bookorbit-timings' });
  });

  it('never asks the resolver about an EPUB row', async () => {
    const resolver: EpubDomSourceResolver = { resolveEpubDomSource: vi.fn() };
    const service = new EpubDomService(makeDb(indexPath, 'epub') as never, resolver);

    await expect(service.getSpineHrefs(41)).resolves.toEqual(['OEBPS/text/ch1.xhtml']);
    expect(resolver.resolveEpubDomSource).not.toHaveBeenCalled();
  });

  it('returns null when the resolver declines', async () => {
    const service = new EpubDomService(makeDb(indexPath, 'bookorbit-timings') as never, { resolveEpubDomSource: vi.fn().mockResolvedValue(null) });
    await expect(service.getSpineHrefs(42)).resolves.toBeNull();
  });
});
