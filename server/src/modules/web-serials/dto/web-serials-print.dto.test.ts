import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { WebSerialDownloadDto } from './web-serials-print.dto';

async function errorsFor(plain: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(WebSerialDownloadDto, plain) as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

const download = {
  title: 'Story',
  altTitles: [],
  volumeCount: 4,
  seriesRequestId: 1,
  picks: [{ indexerId: 1, releaseGuid: 'single', unitIndexes: null, volumes: [3] }],
};

describe('WebSerialDownloadDto', () => {
  it.each([undefined, null])('accepts a download with no top-level client (%s)', async (downloadClientId) => {
    expect(await errorsFor({ ...download, downloadClientId })).toEqual([]);
  });

  it('still rejects an invalid client id', async () => {
    expect(await errorsFor({ ...download, downloadClientId: 0 })).toEqual(['downloadClientId']);
  });
});
