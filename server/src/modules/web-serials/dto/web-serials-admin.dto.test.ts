import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  MangaExtensionParamsDto,
  MangaExtensionQueryDto,
  TestWebSerialEngineDto,
  UpdateWebSerialSettingsDto,
  WebSerialExtensionRepoDto,
} from './web-serials-admin.dto';

async function errorsFor<T extends object>(cls: new () => T, plain: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain) as object, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((e) => [...(e.constraints ? [`${prefix}${e.property}`] : []), ...flatten(e.children ?? [], `${prefix}${e.property}.`)]);
  return flatten(errors);
}

describe('UpdateWebSerialSettingsDto', () => {
  it('accepts an empty body and a full body', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, {})).toEqual([]);
    expect(
      await errorsFor(UpdateWebSerialSettingsDto, {
        manga: { url: 'http://m', username: 'u', password: 'p', languages: ['en', 'zh-hans'], targetLibraryId: 1, targetFolderId: 2 },
        novel: { url: 'http://n', searchDomains: ['a.com'], targetLibraryId: null, targetFolderId: null, defaultPackaging: 'series', password: null },
        maxConcurrentJobs: 6,
        lookup: { enabled: false },
      }),
    ).toEqual([]);
  });

  it('rejects concurrency outside 1..6', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { maxConcurrentJobs: 0 })).toEqual(['maxConcurrentJobs']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { maxConcurrentJobs: 7 })).toEqual(['maxConcurrentJobs']);
  });

  it('rejects a chapter packaging default and unknown fields', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { defaultPackaging: 'chapter' } })).toEqual(['novel.defaultPackaging']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { transport: 'x' } })).toEqual(['novel.transport']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { extra: 1 })).toEqual(['extra']);
  });

  it('bounds the daily index budget', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { indexDailyBudget: 1500 } })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { indexDailyBudget: 5 } })).toEqual(['novel.indexDailyBudget']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { indexDailyBudget: 20001 } })).toEqual(['novel.indexDailyBudget']);
  });

  it('rejects malformed language codes and oversized values', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { languages: ['en us'] } })).toEqual(['manga.languages']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { url: 'x'.repeat(2049) } })).toEqual(['manga.url']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { novel: { searchDomains: ['x'.repeat(256)] } })).toEqual(['novel.searchDomains']);
  });

  it('validates manga source ids', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: ['4215511432986138970', '2'] } })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: [] } })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: ['abc'] } })).toEqual(['manga.sourceIds']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: [12] } })).toEqual(['manga.sourceIds']);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: Array.from({ length: 5000 }, (_, i) => String(i)) } })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { sourceIds: Array.from({ length: 5001 }, (_, i) => String(i)) } })).toEqual([
      'manga.sourceIds',
    ]);
  });

  it('rejects non-positive library ids', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { manga: { targetLibraryId: 0 } })).toEqual(['manga.targetLibraryId']);
  });

  it('validates the lookup toggle', async () => {
    expect(await errorsFor(UpdateWebSerialSettingsDto, { lookup: { enabled: true } })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialSettingsDto, { lookup: { enabled: 'yes' } })).toEqual(['lookup.enabled']);
  });
});

describe('TestWebSerialEngineDto', () => {
  it('requires a known kind', async () => {
    expect(await errorsFor(TestWebSerialEngineDto, { kind: 'manga' })).toEqual([]);
    expect(await errorsFor(TestWebSerialEngineDto, { kind: 'novel', url: 'http://n', username: 'u', password: 'p' })).toEqual([]);
    expect(await errorsFor(TestWebSerialEngineDto, {})).toEqual(['kind']);
    expect(await errorsFor(TestWebSerialEngineDto, { kind: 'comic' })).toEqual(['kind']);
  });
});

describe('manga extension DTOs', () => {
  it('accepts and transforms a bounded catalogue query', async () => {
    const query = plainToInstance(MangaExtensionQueryDto, {
      query: ' alpha ',
      lang: 'en',
      installed: 'false',
      adult: 'true',
      limit: '100',
      offset: '10',
    });

    expect(await validate(query)).toEqual([]);
    expect(query).toMatchObject({ query: 'alpha', installed: false, adult: true, limit: 100, offset: 10 });
  });

  it('rejects invalid catalogue values and package names', async () => {
    expect(await errorsFor(MangaExtensionQueryDto, { installed: 'yes' })).toEqual(['installed']);
    expect(await errorsFor(MangaExtensionQueryDto, { limit: 101 })).toEqual(['limit']);
    expect(await errorsFor(MangaExtensionQueryDto, { offset: -1 })).toEqual(['offset']);
    expect(await errorsFor(MangaExtensionParamsDto, { pkgName: 'bad-package!' })).toEqual(['pkgName']);
    expect(await errorsFor(MangaExtensionParamsDto, { pkgName: 'eu.kanade.extension.en.alpha' })).toEqual([]);
  });

  it('requires an http or https repository URL no longer than 2048 characters', async () => {
    expect(await errorsFor(WebSerialExtensionRepoDto, { url: ' https://example.com/index.pb ' })).toEqual([]);
    expect(await errorsFor(WebSerialExtensionRepoDto, { url: 'ftp://example.com/index.pb' })).toEqual(['url']);
    expect(await errorsFor(WebSerialExtensionRepoDto, { url: 'not a url' })).toEqual(['url']);
    expect(await errorsFor(WebSerialExtensionRepoDto, { url: `https://example.com/${'x'.repeat(2049)}` })).toEqual(['url']);
  });
});
