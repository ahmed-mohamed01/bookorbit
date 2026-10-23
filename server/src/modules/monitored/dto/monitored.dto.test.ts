import { ValidationPipe } from '@nestjs/common';
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MONITORED_MARK_KINDS } from '@bookorbit/types';

import {
  BulkRequestWorksDto,
  BulkUpdateWorksDto,
  GrabWorkReleaseDto,
  ListMonitoredAuthorsDto,
  ListMonitoredBooksDto,
  ListMonitoredReleasesDto,
  MonitorAuthorDto,
  MonitoredCatalogSearchQueryDto,
  MonitoredAuthorDetailQueryDto,
  SearchMonitoredWorksDto,
  UpdateMonitoredWorkDto,
} from './monitored.dto';

const MAX_INT4 = 2147483647;

function monitorAuthor(patch: Record<string, unknown>) {
  return plainToInstance(MonitorAuthorDto, { authorName: 'Probe', formats: {}, ...patch });
}

describe('MonitorAuthorDto', () => {
  it('accepts a partial format object and defaults the destination to null', async () => {
    const dto = monitorAuthor({ formats: { ebook: { mode: 'off' } } });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.formats.ebook).toMatchObject({ mode: 'off', libraryId: null, folderId: null });
  });

  it('still accepts explicitly null destinations', async () => {
    await expect(validate(monitorAuthor({ formats: { ebook: { mode: 'off', libraryId: null, folderId: null } } }))).resolves.toHaveLength(0);
  });

  it.each([
    ['libraryId', { formats: { ebook: { mode: 'off', libraryId: MAX_INT4 + 1, folderId: null } } }],
    ['folderId', { formats: { ebook: { mode: 'off', libraryId: null, folderId: MAX_INT4 + 1 } } }],
    ['localAuthorId', { localAuthorId: MAX_INT4 + 1 }],
  ])('rejects a %s beyond the int4 column range', async (_field, patch) => {
    await expect(validate(monitorAuthor(patch))).resolves.not.toHaveLength(0);
  });

  it.each([
    ['libraryId', { formats: { ebook: { mode: 'off', libraryId: MAX_INT4, folderId: null } } }],
    ['localAuthorId', { localAuthorId: MAX_INT4 }],
  ])('accepts the largest storable %s', async (_field, patch) => {
    await expect(validate(monitorAuthor(patch))).resolves.toHaveLength(0);
  });

  it('rejects a provider id longer than its column', async () => {
    await expect(validate(monitorAuthor({ providerIds: { audible: 'A'.repeat(256) } }))).resolves.not.toHaveLength(0);
    await expect(validate(monitorAuthor({ providerIds: { audible: 'A'.repeat(255) } }))).resolves.toHaveLength(0);
  });
});

describe('GrabWorkReleaseDto', () => {
  it('rejects an indexer id beyond the int4 column range', async () => {
    const base = { format: 'ebook', releaseGuid: 'guid' };

    await expect(validate(plainToInstance(GrabWorkReleaseDto, { ...base, indexerId: MAX_INT4 + 1 }))).resolves.not.toHaveLength(0);
    await expect(validate(plainToInstance(GrabWorkReleaseDto, { ...base, indexerId: 1 }))).resolves.toHaveLength(0);
  });
});

describe('UpdateMonitoredWorkDto', () => {
  it.each(['autoDownloadEbook', 'autoDownloadAudiobook'])('validates nullable %s through the strict pipe', async (field) => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    for (const value of [true, false, null]) {
      await expect(pipe.transform({ [field]: value }, { type: 'body', metatype: UpdateMonitoredWorkDto })).resolves.toMatchObject({ [field]: value });
    }
    await expect(pipe.transform({ [field]: 'true' }, { type: 'body', metatype: UpdateMonitoredWorkDto })).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the automatic visibility flag as true only', async () => {
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { automaticVisibility: true }))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { automaticVisibility: 'yes' }))).resolves.not.toHaveLength(0);
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { automaticVisibility: false }))).resolves.not.toHaveLength(0);
  });

  it.each(MONITORED_MARK_KINDS)('accepts the %s mark kind', async (kind) => {
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { kind }))).resolves.toHaveLength(0);
  });

  it('rejects a null mark kind instead of reading it as a mark', async () => {
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { kind: null }))).resolves.not.toHaveLength(0);
  });

  it('rejects an unknown mark kind', async () => {
    await expect(validate(plainToInstance(UpdateMonitoredWorkDto, { kind: 'magazine' }))).resolves.not.toHaveLength(0);
  });
});

describe('monitored bulk DTOs', () => {
  const validationOptions = { whitelist: true, forbidNonWhitelisted: true } as const;

  it('accepts valid bulk request and update payloads', async () => {
    const request = plainToInstance(BulkRequestWorksDto, {
      workIds: ['work-1', 'work-2'],
      format: 'both',
      autoDownload: false,
      sources: { ebook: [1, 2], audiobook: null },
    });
    const update = plainToInstance(BulkUpdateWorksDto, { workIds: ['work-1'], patch: { monitorEbook: false, automaticVisibility: true } });

    await expect(validate(request, validationOptions)).resolves.toHaveLength(0);
    await expect(validate(update, validationOptions)).resolves.toHaveLength(0);
  });

  it.each([
    ['empty ids', { workIds: [], format: 'ebook' }],
    ['more than 100 ids', { workIds: Array.from({ length: 101 }, (_, index) => `work-${index}`), format: 'ebook' }],
    ['duplicate ids', { workIds: ['work-1', 'work-1'], format: 'ebook' }],
    ['an unsupported format', { workIds: ['work-1'], format: 'paperback' }],
  ])('rejects bulk requests with %s', async (_label, payload) => {
    await expect(validate(plainToInstance(BulkRequestWorksDto, payload), validationOptions)).resolves.not.toHaveLength(0);
  });

  it.each([
    ['an empty list', { ebook: [] }],
    ['duplicate ids', { ebook: [1, 1] }],
    ['a non-integer id', { audiobook: [1.5] }],
    ['too many ids', { ebook: Array.from({ length: 51 }, (_, index) => index + 1) }],
    ['an unknown format', { ebook: [1], comic: [2] }],
  ])('rejects bulk request sources with %s', async (_label, sources) => {
    const request = plainToInstance(BulkRequestWorksDto, { workIds: ['work-1'], format: 'both', sources });

    await expect(validate(request, validationOptions)).resolves.not.toHaveLength(0);
  });

  it.each([
    ['empty ids', { workIds: [], patch: { hidden: true } }],
    ['more than 100 ids', { workIds: Array.from({ length: 101 }, (_, index) => `work-${index}`), patch: { hidden: true } }],
    ['duplicate ids', { workIds: ['work-1', 'work-1'], patch: { hidden: true } }],
    ['an unknown patch field', { workIds: ['work-1'], patch: { title: 'Changed' } }],
    ['an unknown mark kind', { workIds: ['work-1'], patch: { kind: 'magazine' } }],
    ['a null mark kind', { workIds: ['work-1'], patch: { kind: null } }],
  ])('rejects bulk updates with %s', async (_label, payload) => {
    await expect(validate(plainToInstance(BulkUpdateWorksDto, payload), validationOptions)).resolves.not.toHaveLength(0);
  });
});

describe('bulk mark kinds', () => {
  const validationOptions = { whitelist: true, forbidNonWhitelisted: true } as const;

  it.each(MONITORED_MARK_KINDS)('accepts the %s mark kind in a bulk update', async (kind) => {
    await expect(validate(plainToInstance(BulkUpdateWorksDto, { workIds: ['work-1'], patch: { kind } }), validationOptions)).resolves.toHaveLength(0);
  });
});

describe('MonitoredCatalogSearchQueryDto', () => {
  it('requires at least three characters, the length at which the title trigram index narrows the scan', async () => {
    await expect(validate(plainToInstance(MonitoredCatalogSearchQueryDto, { q: 'mi' }))).resolves.not.toHaveLength(0);
    await expect(validate(plainToInstance(MonitoredCatalogSearchQueryDto, { q: 'mis' }))).resolves.toHaveLength(0);
  });
});

describe('monitored list query DTOs', () => {
  it.each([ListMonitoredAuthorsDto, ListMonitoredBooksDto, ListMonitoredReleasesDto])(
    '%s uses the zero-based page and size defaults and enforces the hard cap',
    async (RawDto) => {
      const Dto = RawDto as typeof ListMonitoredAuthorsDto;
      const defaults = plainToInstance(Dto, {});
      const oversized = plainToInstance(Dto, { page: 0, size: 201 });

      expect(defaults).toMatchObject({ page: 0, size: 50 });
      await expect(validate(defaults)).resolves.toHaveLength(0);
      await expect(validate(oversized)).resolves.not.toHaveLength(0);
    },
  );

  it.each([ListMonitoredReleasesDto, MonitoredAuthorDetailQueryDto])('%s reads a comma-separated status filter', async (RawDto) => {
    const Dto = RawDto as typeof ListMonitoredReleasesDto;
    const dto = plainToInstance(Dto, { status: 'missing,upcoming,missing' });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.status).toEqual(['missing', 'upcoming']);
    await expect(validate(plainToInstance(Dto, {}))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(Dto, { status: 'missing,bogus' }))).resolves.not.toHaveLength(0);
    await expect(validate(plainToInstance(Dto, { status: ',' }))).resolves.not.toHaveLength(0);
  });

  it('accepts the sort and filter values exposed by the monitored view', async () => {
    await expect(validate(plainToInstance(ListMonitoredAuthorsDto, { sort: 'progress', order: 'desc', q: '  Le Guin  ' }))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(ListMonitoredBooksDto, { sort: 'author', order: 'asc' }))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(ListMonitoredReleasesDto, { sort: 'title', order: 'desc', filter: 'soon' }))).resolves.toHaveLength(0);
  });
});

describe('release display classes', () => {
  it('parses kinds and review flags through the strict boundary', async () => {
    const dto = plainToInstance(ListMonitoredReleasesDto, { kinds: 'graphic_novel,collection', more: 'unconfirmed' });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(dto).toMatchObject({ kinds: ['graphic_novel', 'collection'], more: ['unconfirmed'] });
  });

  it('returns HTTP 400 for an invalid release kind', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform({ kinds: 'bogus' }, { type: 'query', metatype: ListMonitoredReleasesDto })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid kinds and flags', async () => {
    for (const query of [{ kinds: 'bogus' }, { more: 'bogus' }]) {
      expect(await validate(plainToInstance(ListMonitoredReleasesDto, query))).not.toHaveLength(0);
    }
  });
});

describe('SearchMonitoredWorksDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const parse = (query: Record<string, unknown>) => pipe.transform(query, { type: 'query', metatype: SearchMonitoredWorksDto });

  it('trims q and applies the paging defaults', async () => {
    await expect(parse({ q: '  dune  ' })).resolves.toMatchObject({ q: 'dune', page: 0, size: 50 });
  });

  it('rejects a query shorter than three characters after trimming', async () => {
    await expect(parse({ q: ' ab ' })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a page past the bound before it can overflow the offset', async () => {
    await expect(parse({ q: 'dune', page: '10000' })).resolves.toMatchObject({ page: 10000 });
    await expect(parse({ q: 'dune', page: '10001' })).rejects.toMatchObject({ status: 400 });
    await expect(parse({ q: 'dune', page: '1e18' })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects the list order it does not read', async () => {
    await expect(parse({ q: 'dune', order: 'asc' })).rejects.toMatchObject({ status: 400 });
  });
});
