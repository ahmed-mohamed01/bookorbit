import type { BookDockMetadata } from '@bookorbit/types';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as verification from '../fulfillment/request-verification.service';
import { BatchUnitFilingService } from './batch-unit-filing.service';
import { BookRequestBatchRepository } from './book-request-batch.repository';
import { BookRequestRepository } from '../book-request.repository';
import { BookRequestGateway } from '../book-request.gateway';
import { RequestAutomationSettingsService } from '../fulfillment/request-automation-settings.service';
import { BookDockEventsService, BOOK_DOCK_FILE_INGESTED } from '../../book-dock/book-dock-events.service';
import { BookDockRepository } from '../../book-dock/book-dock.repository';
import { BookDockService } from '../../book-dock/book-dock.service';
import { BookDockFinalizeService } from '../../book-dock/book-dock-finalize.service';

describe('BatchUnitFilingService', () => {
  async function setup() {
    const unit = { id: 3, requestId: 2, title: 'Mort', primaryPath: 'Mort.epub', status: 'in_dock', bookDockFileId: 1 };
    const batches = { findUnitByDockFileId: vi.fn().mockResolvedValue(unit), markFiled: vi.fn(), updateUnit: vi.fn() };
    const requests = {
      findById: vi.fn().mockResolvedValue({ request: { id: 2, title: 'Pack', authors: [], targetLibraryId: 4, targetFolderId: null } }),
      findFirstFolderId: vi.fn().mockResolvedValue(5),
    };
    const row = {
      fetchedMetadata: { title: 'Mort' } as BookDockMetadata,
      embeddedMetadata: null as BookDockMetadata | null,
      selectedMetadata: { publisher: 'Existing' } as BookDockMetadata | null,
      uploadedBy: 7,
    };
    const dockRepo = { findById: vi.fn().mockResolvedValue(row) };
    const dock = { updateFile: vi.fn() };
    const finalize = { finalizeManagedFile: vi.fn().mockResolvedValue({ success: true, bookId: 8 }) };
    const settings = { get: vi.fn().mockResolvedValue({ verificationEnabled: true, verificationThreshold: 70 }) };
    const gateway = { emitChanged: vi.fn() };
    const events = new BookDockEventsService();
    const module = await Test.createTestingModule({
      providers: [
        BatchUnitFilingService,
        ...[
          [BookRequestBatchRepository, batches],
          [BookRequestRepository, requests],
          [BookDockRepository, dockRepo],
          [BookDockService, dock],
          [BookDockFinalizeService, finalize],
          [RequestAutomationSettingsService, settings],
          [BookRequestGateway, gateway],
          [BookDockEventsService, events],
        ].map(([provide, useValue]) => ({ provide, useValue })),
      ],
    }).compile();
    const service = module.get(BatchUnitFilingService);
    service.onModuleInit();
    return { service, batches, requests, row, dock, finalize, settings, gateway, events };
  }
  it('no resolver keeps the existing verify', async () => {
    const h = await setup();
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.finalize.finalizeManagedFile).toHaveBeenCalledWith(1, { libraryId: 4, folderId: 5 });
    expect(h.batches.markFiled).toHaveBeenCalledWith(3, 8);
    expect(h.gateway.emitChanged).toHaveBeenCalled();
  });
  it('files a unit whose ingest arrives while it is still placing', async () => {
    const h = await setup();
    h.batches.findUnitByDockFileId.mockResolvedValueOnce({
      id: 3,
      requestId: 2,
      title: 'Mort',
      primaryPath: 'Mort.epub',
      status: 'placing',
      bookDockFileId: 1,
    });
    h.events.emit(BOOK_DOCK_FILE_INGESTED, 1);
    await vi.waitFor(() => expect(h.batches.markFiled).toHaveBeenCalledWith(3, 8));
  });
  it('skips a unit linked to a different dock file', async () => {
    const h = await setup();
    expect(await h.service.fileUnit(2)).toBe('skipped');
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
  });
  it('holds an unverified unit in Book Dock with the reason', async () => {
    const h = await setup();
    h.row.fetchedMetadata.title = 'Different book';
    expect(await h.service.fileUnit(1)).toBe('held');
    expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: expect.any(String) });
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
  });
  it('files without verifying when verification is off', async () => {
    const h = await setup();
    h.settings.get.mockResolvedValue({ verificationEnabled: false });
    h.row.fetchedMetadata.title = 'Other';
    expect(await h.service.fileUnit(1)).toBe('filed');
  });
  it('holds finalization failures with their reason', async () => {
    const h = await setup();
    h.finalize.finalizeManagedFile.mockResolvedValue({ success: false, message: 'No space' });
    expect(await h.service.fileUnit(1)).toBe('held');
    expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: 'No space' });
    expect(h.batches.markFiled).not.toHaveBeenCalled();
  });
  it('skips filed units and requests without a library', async () => {
    const h = await setup();
    h.batches.findUnitByDockFileId.mockResolvedValueOnce({ status: 'filed' });
    expect(await h.service.fileUnit(1)).toBe('skipped');
    h.requests.findById.mockResolvedValueOnce({ request: { targetLibraryId: null } });
    expect(await h.service.fileUnit(1)).toBe('skipped');
  });
  it('deduplicates concurrent filing calls', async () => {
    const h = await setup();
    expect(await Promise.all([h.service.fileUnit(1), h.service.fileUnit(1)])).toEqual(['filed', 'filed']);
    expect(h.finalize.finalizeManagedFile).toHaveBeenCalledTimes(1);
  });
  it('skips non-batch dock files', async () => {
    const h = await setup();
    h.batches.findUnitByDockFileId.mockResolvedValue(undefined);
    expect(await h.service.fileUnit(1)).toBe('skipped');
  });
  it('files only on ingest, not on in_dock placement', async () => {
    const h = await setup();
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
    h.events.emit(BOOK_DOCK_FILE_INGESTED, 1);
    await vi.waitFor(() => expect(h.batches.markFiled).toHaveBeenCalled());
  });
  it('applies a registered metadata resolver before verifying', async () => {
    const h = await setup();
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Discworld', seriesIndex: '4' }));
    await h.service.fileUnit(1);
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      { selectedMetadata: { title: 'Mort', publisher: 'Existing', seriesName: 'Discworld', seriesIndex: '4' } },
      7,
      true,
    );
    expect(h.dock.updateFile.mock.invocationCallOrder[0]).toBeLessThan(h.settings.get.mock.invocationCallOrder[0]!);
  });
  it.each([
    {
      name: 'series fields are added on top of the embedded title and authors',
      embedded: { title: 'Embedded title', authors: ['Embedded author'] },
      fetched: {},
      selected: null,
      expected: { title: 'Embedded title', authors: ['Embedded author'] },
    },
    {
      name: 'an existing partial selection is completed from embedded/fetched',
      embedded: { title: 'Embedded title', authors: ['Embedded author'], publisher: 'Embedded publisher' },
      fetched: { publisher: 'Fetched publisher' },
      selected: { seriesName: 'Old series', seriesIndex: '99', language: 'en' },
      expected: { title: 'Embedded title', authors: ['Embedded author'], publisher: 'Fetched publisher', language: 'en' },
    },
    {
      name: 'fetched fields win over embedded',
      embedded: { title: 'Embedded title', authors: ['Embedded author'], publisher: 'Embedded publisher' },
      fetched: { title: 'Fetched title', authors: ['Fetched author'], publisher: 'Fetched publisher' },
      selected: { publisher: 'Selected publisher' },
      expected: { title: 'Fetched title', authors: ['Fetched author'], publisher: 'Selected publisher' },
    },
    {
      name: 'empty values never overwrite filled ones',
      embedded: { title: 'Embedded title', authors: ['Embedded author'], publisher: 'Embedded publisher', language: 'en' },
      fetched: { title: '', authors: [], publisher: null, language: 'fr' },
      selected: { title: '   ', authors: [], publisher: '', language: null },
      expected: { title: 'Embedded title', authors: ['Embedded author'], publisher: 'Embedded publisher', language: 'fr' },
    },
  ])('$name', async ({ embedded, fetched, selected, expected }) => {
    const h = await setup();
    h.settings.get.mockResolvedValue({ verificationEnabled: false });
    h.row.embeddedMetadata = embedded;
    h.row.fetchedMetadata = fetched;
    h.row.selectedMetadata = selected;
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Resolved series', seriesIndex: '23', authors: ['Resolved author'] }));
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      { selectedMetadata: { ...expected, seriesName: 'Resolved series', seriesIndex: '23' } },
      7,
      true,
    );
  });
  it('uses resolved authors only when the merged metadata has none', async () => {
    const h = await setup();
    h.settings.get.mockResolvedValue({ verificationEnabled: false });
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Resolved series', seriesIndex: '23', authors: ['Resolved author'] }));
    await h.service.fileUnit(1);
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      { selectedMetadata: { title: 'Mort', publisher: 'Existing', seriesName: 'Resolved series', seriesIndex: '23', authors: ['Resolved author'] } },
      7,
      true,
    );
  });
  it('series-aware verify files a unit whose title names the series and its volume', async () => {
    const h = await setup();
    h.settings.get.mockResolvedValue({ verificationEnabled: true, verificationThreshold: 80 });
    h.row.fetchedMetadata.title = 'Mushoku Tensei - Volume 01 - Infancy Period';
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei: Jobless Reincarnation', seriesIndex: '1' }));
    const log = vi.spyOn(Logger.prototype, 'log');
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verify=series'));
    log.mockRestore();
  });
  it('provider title without a volume and EPUB title with the right volume files', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Mushoku Tensei', seriesIndex: null };
    h.row.embeddedMetadata = { title: 'Mushoku Tensei - Volume 09 - Youth Period - Sylphiette Chapter' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '9' }));
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.batches.markFiled).toHaveBeenCalledWith(3, 8);
  });

  it.each(['providerTitle', 'providerIndex', 'embeddedTitle', 'embeddedIndex', 'unitTitle', 'path', 'providerAndPath'] as const)(
    'any source naming a different volume holds unless only the provider disagrees (%s)',
    async (source) => {
      const h = await setup();
      h.row.fetchedMetadata = { title: 'Mushoku Tensei Volume 09' };
      h.row.embeddedMetadata = { title: 'Mushoku Tensei Volume 09' };
      const unit = await h.batches.findUnitByDockFileId();
      if (source === 'providerTitle' || source === 'providerAndPath') h.row.fetchedMetadata.title = 'Mushoku Tensei Volume 08';
      if (source === 'providerIndex') h.row.fetchedMetadata.seriesIndex = '8';
      if (source === 'embeddedTitle') h.row.embeddedMetadata.title = 'Mushoku Tensei Volume 08';
      if (source === 'embeddedIndex') h.row.embeddedMetadata.seriesIndex = '8';
      if (source === 'unitTitle') unit.title = 'Mushoku Tensei Volume 08';
      if (source === 'path' || source === 'providerAndPath') unit.primaryPath = '/books/Mushoku Tensei Volume 08.epub';
      h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '9' }));
      const providerOnly = source === 'providerTitle' || source === 'providerIndex';
      expect(await h.service.fileUnit(1)).toBe(providerOnly ? 'filed' : 'held');
      if (!providerOnly) {
        expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: 'imported book is volume 8, expected volume 9' });
        expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['embeddedTitle', 'unitTitle', 'path', 'embeddedAuthor'] as const)('matches series identity against every source (%s)', async (source) => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Alternate title', seriesIndex: '9' };
    h.row.embeddedMetadata = { title: 'Another title' };
    const unit = await h.batches.findUnitByDockFileId();
    if (source === 'embeddedTitle') h.row.embeddedMetadata.title = 'Mushoku Tensei';
    if (source === 'unitTitle') unit.title = 'Mushoku Tensei';
    if (source === 'path') unit.primaryPath = '/books/Mushoku Tensei.epub';
    if (source === 'embeddedAuthor') h.row.embeddedMetadata.authors = ['Author'];
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '9', authors: ['Author'] }));
    expect(await h.service.fileUnit(1)).toBe('filed');
  });

  it('provider disagreeing on volume files with embedded metadata plus series fields', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Mushoku Tensei Vol. 14', authors: ['Manga author'] };
    h.row.embeddedMetadata = { title: 'Mushoku Tensei Vol. 23', authors: ['Embedded author'], language: 'en' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '23', authors: ['Series author'] }));
    const log = vi.spyOn(Logger.prototype, 'log');
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      { selectedMetadata: { ...h.row.embeddedMetadata, seriesName: 'Mushoku Tensei', seriesIndex: '23' } },
      7,
      true,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verify=series-embedded'));
    log.mockRestore();
  });
  it('provider cover and authors are not carried when it disagrees', async () => {
    const h = await setup();
    h.row.fetchedMetadata = {
      title: 'Mushoku Tensei Vol. 14',
      authors: ['Manga author'],
      coverUrl: 'https://example.com/manga.jpg',
      description: 'Manga',
      isbn: '123',
    };
    h.row.selectedMetadata = { ...h.row.fetchedMetadata };
    h.row.embeddedMetadata = { title: 'Mushoku Tensei Vol. 23' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '23', authors: ['Series author'] }));
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      { selectedMetadata: { title: 'Mushoku Tensei Vol. 23', seriesName: 'Mushoku Tensei', seriesIndex: '23', authors: ['Series author'] } },
      7,
      true,
    );
  });
  it('embedded naming a different volume is still held', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Mushoku Tensei Vol. 14' };
    h.row.embeddedMetadata = { title: 'Mushoku Tensei Vol. 22' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '23' }));
    expect(await h.service.fileUnit(1)).toBe('held');
    expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: 'imported book is volume 22, expected volume 23' });
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
  });
  it('agreeing provider keeps the merged selection', async () => {
    const h = await setup();
    h.row.embeddedMetadata = { title: 'Mushoku Tensei Vol. 23', language: 'en', publisher: 'Embedded' };
    h.row.fetchedMetadata = { title: 'Mushoku Tensei Vol. 23', authors: ['Provider author'], publisher: 'Provider' };
    h.row.selectedMetadata = { publisher: 'Selected' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '23', authors: ['Series author'] }));
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(h.dock.updateFile).toHaveBeenCalledWith(
      1,
      {
        selectedMetadata: {
          title: 'Mushoku Tensei Vol. 23',
          language: 'en',
          authors: ['Provider author'],
          publisher: 'Selected',
          seriesName: 'Mushoku Tensei',
          seriesIndex: '23',
        },
      },
      7,
      true,
    );
  });
  it('a different volume in the imported title is held without fallback', async () => {
    const h = await setup();
    h.settings.get.mockResolvedValue({ verificationEnabled: true, verificationThreshold: 80 });
    h.row.embeddedMetadata = { title: 'Mushoku Tensei Volume 02', authors: ['Author'], seriesIndex: '1' };
    const fallback = vi.spyOn(verification, 'verifyAgainstRequest');
    h.service.registerMetadataResolver(() =>
      Promise.resolve({ seriesName: 'Mushoku Tensei: Jobless Reincarnation', seriesIndex: '1', authors: ['Author'] }),
    );
    expect(await h.service.fileUnit(1)).toBe('held');
    expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: 'imported book is volume 2, expected volume 1' });
    expect(fallback).not.toHaveBeenCalled();
    fallback.mockRestore();
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
  });
  it.each(['embeddedMetadata'] as const)('a different seriesIndex in metadata is held (%s)', async (source) => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Mushoku Tensei Volume 01' };
    Object.assign(h.row, { [source]: { title: 'Mushoku Tensei', seriesIndex: '2' } });
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '1' }));
    const fallback = vi.spyOn(verification, 'verifyAgainstRequest');
    expect(await h.service.fileUnit(1)).toBe('held');
    expect(h.batches.updateUnit).toHaveBeenCalledWith(3, { errorMessage: 'imported book is volume 2, expected volume 1' });
    expect(fallback).not.toHaveBeenCalled();
    expect(h.finalize.finalizeManagedFile).not.toHaveBeenCalled();
    fallback.mockRestore();
  });
  it('author match passes when the title is a romanized alt title', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Isekai Ittara Honki Dasu Vol 1', authors: ['  RIFUJIN NA MAGONOTE '] };
    h.service.registerMetadataResolver(() =>
      Promise.resolve({
        seriesName: 'Mushoku Tensei',
        seriesIndex: '1',
        authors: ['Rifujin na Magonote'],
      }),
    );
    expect(await h.service.fileUnit(1)).toBe('filed');
  });
  it('accepts the imported series index and series name', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Infancy Period', seriesName: 'Mushoku-Tensei', seriesIndex: '01' };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '1' }));
    expect(await h.service.fileUnit(1)).toBe('filed');
  });
  it('no volume in metadata falls back', async () => {
    const h = await setup();
    h.row.fetchedMetadata = { title: 'Mushoku Tensei', authors: ['Author'] };
    h.service.registerMetadataResolver(() => Promise.resolve({ seriesName: 'Mushoku Tensei', seriesIndex: '1', authors: ['Author'] }));
    const log = vi.spyOn(Logger.prototype, 'log');
    expect(await h.service.fileUnit(1)).toBe('filed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verify=fallback'));
    log.mockRestore();
  });
  it('listener errors are logged, never thrown', async () => {
    const h = await setup();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    h.batches.findUnitByDockFileId.mockRejectedValue(new Error('lookup failed'));
    expect(() => h.events.emit(BOOK_DOCK_FILE_INGESTED, 1)).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    log.mockRestore();
  });
});
