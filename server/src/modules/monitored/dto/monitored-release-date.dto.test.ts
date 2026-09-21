import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MonitoredWorkFormatParamsDto, MonitoredWorkParamsDto, SetMonitoredReleaseDateDto } from './monitored-release-date.dto';

// The same options main.ts registers globally, so a path param really is validated before the route.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function params(patch: Record<string, unknown>) {
  return plainToInstance(MonitoredWorkFormatParamsDto, { workId: 'monitor-1:hardcover:1', format: 'ebook', ...patch });
}

function workParams(patch: Record<string, unknown>) {
  return plainToInstance(MonitoredWorkParamsDto, { workId: 'monitor-1:hardcover:1', ...patch });
}

function body(releaseDate: unknown) {
  return plainToInstance(SetMonitoredReleaseDateDto, { releaseDate });
}

describe('MonitoredWorkFormatParamsDto', () => {
  it.each(['ebook', 'audiobook'])('accepts the %s format', async (format) => {
    await expect(validate(params({ format }))).resolves.toHaveLength(0);
  });

  it.each(['print', 'audio', '', 'EBOOK'])('rejects %s as a format', async (format) => {
    await expect(validate(params({ format }))).resolves.not.toHaveLength(0);
  });

  it('rejects a work id longer than the column it looks up', async () => {
    await expect(validate(params({ workId: 'w'.repeat(201) }))).resolves.not.toHaveLength(0);
  });

  it('is rejected with a 400 by the global pipe before the route runs', async () => {
    const metadata = { type: 'param' as const, metatype: MonitoredWorkFormatParamsDto };

    await expect(pipe.transform({ workId: 'monitor-1:hardcover:1', format: 'print' }, metadata)).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ workId: 'monitor-1:hardcover:1', format: 'ebook' }, metadata)).resolves.toMatchObject({ format: 'ebook' });
  });
});

describe('MonitoredWorkParamsDto', () => {
  it('accepts a work id the column can hold', async () => {
    await expect(validate(workParams({}))).resolves.toHaveLength(0);
  });

  it.each([['w'.repeat(201)], [42], [undefined]])('rejects %s as a work id', async (workId) => {
    await expect(validate(workParams({ workId }))).resolves.not.toHaveLength(0);
  });

  it('is rejected with a 400 by the global pipe before the refresh route runs', async () => {
    const metadata = { type: 'param' as const, metatype: MonitoredWorkParamsDto };

    await expect(pipe.transform({ workId: 'w'.repeat(201) }, metadata)).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ workId: 'monitor-1:hardcover:1' }, metadata)).resolves.toMatchObject({ workId: 'monitor-1:hardcover:1' });
  });
});

describe('SetMonitoredReleaseDateDto', () => {
  it.each(['2027-01-02', '2028-02-29'])('accepts the real calendar date %s', async (releaseDate) => {
    await expect(validate(body(releaseDate))).resolves.toHaveLength(0);
  });

  it('accepts null, which hands the format back to the probe', async () => {
    await expect(validate(body(null))).resolves.toHaveLength(0);
  });

  it.each(['2027-02-30', '2027-13-01', '2027-1-2', '2027-01-02T00:00:00.000Z', 'soon', '', undefined])(
    'rejects %s as a release date',
    async (releaseDate) => {
      await expect(validate(body(releaseDate))).resolves.not.toHaveLength(0);
    },
  );
});
