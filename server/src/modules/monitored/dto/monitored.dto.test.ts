import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GrabWorkReleaseDto, ListMonitoredAuthorsDto, ListMonitoredBooksDto, ListMonitoredReleasesDto, MonitorAuthorDto } from './monitored.dto';

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

describe('monitored list query DTOs', () => {
  it.each([ListMonitoredAuthorsDto, ListMonitoredBooksDto, ListMonitoredReleasesDto])(
    '%s uses the zero-based page and size defaults and enforces the hard cap',
    async (Dto) => {
      const defaults = plainToInstance(Dto, {});
      const oversized = plainToInstance(Dto, { page: 0, size: 201 });

      expect(defaults).toMatchObject({ page: 0, size: 50 });
      await expect(validate(defaults)).resolves.toHaveLength(0);
      await expect(validate(oversized)).resolves.not.toHaveLength(0);
    },
  );

  it('accepts the sort and filter values exposed by the monitored view', async () => {
    await expect(validate(plainToInstance(ListMonitoredAuthorsDto, { sort: 'progress', order: 'desc', q: '  Le Guin  ' }))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(ListMonitoredBooksDto, { sort: 'author', order: 'asc' }))).resolves.toHaveLength(0);
    await expect(validate(plainToInstance(ListMonitoredReleasesDto, { sort: 'title', order: 'desc', filter: 'soon' }))).resolves.toHaveLength(0);
  });
});
