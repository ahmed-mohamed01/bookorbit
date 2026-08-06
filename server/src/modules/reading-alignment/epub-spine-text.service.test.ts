vi.mock('fs/promises', () => ({ stat: vi.fn() }));
vi.mock('unzipper', () => ({ Open: { file: vi.fn() } }));

import { NotFoundException } from '@nestjs/common';
import { stat } from 'fs/promises';
import * as unzipper from 'unzipper';

import { EpubService } from '../reader/epub/epub.service';

const mockStat = stat as MockedFunction<typeof stat>;
const mockOpenFile = (unzipper as any).Open.file as vi.Mock;

function zipEntry(path: string, content: string) {
  const buf = Buffer.from(content);
  return {
    path,
    uncompressedSize: buf.length,
    buffer: vi.fn().mockResolvedValue(buf),
    stream: vi.fn(),
  };
}

function makeArchive(entries: Array<{ path: string; content: string }>) {
  return { files: entries.map((e) => zipEntry(e.path, e.content)) };
}

const CONTAINER_XML = `
<container>
  <rootfiles>
    <rootfile full-path="OPS/content.opf" />
  </rootfiles>
</container>
`;

const OPF_XML = `
<package version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Alignment Test</dc:title>
  </metadata>
  <manifest>
    <item id="chap1" href="text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="chap2" href="text/ch2.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="chap1" />
    <itemref idref="chap2" />
  </spine>
</package>
`;

const CH1_XHTML = `<html><body><h1>Chapter One</h1><p>It was Mr. O&#8217;Brien.</p><script>var x=1;</script></body></html>`;
const CH2_XHTML = `<html><body><p>The &amp; end.</p></body></html>`;

function makeEpubArchive(options?: { omitCh2?: boolean }) {
  const entries = [
    { path: 'META-INF/container.xml', content: CONTAINER_XML },
    { path: 'OPS/content.opf', content: OPF_XML },
    { path: 'OPS/text/ch1.xhtml', content: CH1_XHTML },
  ];
  if (!options?.omitCh2) entries.push({ path: 'OPS/text/ch2.xhtml', content: CH2_XHTML });
  return makeArchive(entries);
}

describe('EpubService.extractSpineText', () => {
  const user = { id: 10, isSuperuser: false, permissions: [] } as any;
  const bookReadService = {
    findLibraryIdByBookId: vi.fn(),
    findFileById: vi.fn(),
    findPrimaryFilesByBookIds: vi.fn(),
  };
  const libraryService = { verifyUserAccess: vi.fn() };
  let service: EpubService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new EpubService(bookReadService as any, libraryService as any);
    bookReadService.findLibraryIdByBookId.mockResolvedValue(3);
    bookReadService.findPrimaryFilesByBookIds.mockResolvedValue([{ format: 'epub', absolutePath: '/books/book.epub', sizeBytes: null }]);
    libraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ mtimeMs: 100 } as Awaited<ReturnType<typeof stat>>);
  });

  it('returns plain text for each spine item in spine order', async () => {
    mockOpenFile.mockResolvedValueOnce(makeEpubArchive() as any).mockResolvedValueOnce(makeEpubArchive() as any);

    const result = await service.extractSpineText(99, undefined, user);

    expect(result).toEqual([
      { spineIndex: 0, text: 'Chapter One It was Mr. O’Brien.' },
      { spineIndex: 1, text: 'The & end.' },
    ]);
    expect(libraryService.verifyUserAccess).toHaveBeenCalledWith(10, 3, false);
  });

  it('yields empty text when a spine entry is missing from the archive', async () => {
    mockOpenFile.mockResolvedValueOnce(makeEpubArchive() as any).mockResolvedValueOnce(makeEpubArchive({ omitCh2: true }) as any);

    const result = await service.extractSpineText(99, undefined, user);

    expect(result).toEqual([
      { spineIndex: 0, text: 'Chapter One It was Mr. O’Brien.' },
      { spineIndex: 1, text: '' },
    ]);
  });

  it('enforces the same ownership check as other reader methods', async () => {
    bookReadService.findLibraryIdByBookId.mockResolvedValueOnce(null);

    await expect(service.extractSpineText(5, undefined, user)).rejects.toThrow(new NotFoundException('Book 5 not found'));
  });
});
