import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EpubService } from './epub.service';

const CONTAINER_XML = '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>';
const OPF_XML = `<package version="3.0">
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;
const CLEAN_XHTML = '<?xml version="1.0" encoding="utf-8"?><html><body><p>Fine.</p></body></html>';
const UNCLOSED_PI_XHTML = '<?xml version="1.0" encoding="utf-8"?><html><body><?page 12 <p>Broken.</p></body></html>';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'epub-spine-check-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeEpub(name: string, chapterTwo: string): Promise<string> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  const entries: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER_XML,
    'OEBPS/content.opf': OPF_XML,
    'OEBPS/ch1.xhtml': CLEAN_XHTML,
    'OEBPS/ch2.xhtml': chapterTwo,
  };
  for (const [path, body] of Object.entries(entries)) archive.append(body, { name: path });
  await archive.finalize();
  await done;
  const target = join(dir, name);
  await writeFile(target, Buffer.concat(chunks));
  return target;
}

describe('EpubService.findMalformedSpineItem', () => {
  const service = new EpubService({} as never, {} as never);

  it('accepts an EPUB whose spine documents all parse', async () => {
    const path = await writeEpub('clean.epub', CLEAN_XHTML);

    await expect(service.findMalformedSpineItem(path)).resolves.toBeNull();
  });

  it('names the first spine document with an unclosed processing instruction', async () => {
    const path = await writeEpub('broken.epub', UNCLOSED_PI_XHTML);

    await expect(service.findMalformedSpineItem(path)).resolves.toEqual({ href: 'OEBPS/ch2.xhtml', message: 'Pi Tag is not closed.' });
  });
});
