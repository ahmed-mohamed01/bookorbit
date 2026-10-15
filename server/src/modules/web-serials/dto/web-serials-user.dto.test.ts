import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  CreateWebSerialJobDto,
  ListWebSerialJobsDto,
  ListWebSerialPublishedRequestsDto,
  MoveWebSerialJobDto,
  ResolveWebSerialUrlDto,
  RecordWebSerialPublishedRequestDto,
  RefreshWebSerialsDto,
  SearchWebSerialsDto,
  SeriesMatchDto,
  SuggestWebSerialsDto,
  UpdateWebSerialNovelProvidersDto,
  WebSerialDiscoverParamsDto,
  WebSerialJobScopeDto,
  WebSerialSeriesKeyParamsDto,
} from './web-serials-user.dto';

async function errorsFor<T extends object>(cls: new () => T, plain: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain) as object, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((e) => [...(e.constraints ? [`${prefix}${e.property}`] : []), ...flatten(e.children ?? [], `${prefix}${e.property}.`)]);
  return flatten(errors);
}

const job = { seriesKey: 'm:1', packaging: 'chapter', selection: { mode: 'all' }, libraryId: 3 };

describe('SearchWebSerialsDto', () => {
  it('requires 2 to 200 characters and a known kind', async () => {
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', kind: 'novel' })).toEqual([]);
    expect(await errorsFor(SearchWebSerialsDto, { q: 'a' })).toEqual(['q']);
    expect(await errorsFor(SearchWebSerialsDto, { q: 'x'.repeat(201) })).toEqual(['q']);
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', kind: 'comic' })).toEqual(['kind']);
  });

  it('accepts the index phase only by name', async () => {
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', kind: 'novel', phase: 'index' })).toEqual([]);
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', phase: 'live' })).toEqual(['phase']);
  });
});

describe('SuggestWebSerialsDto', () => {
  it('takes any short query for novels and nothing else', async () => {
    expect(await errorsFor(SuggestWebSerialsDto, { q: 'o', kind: 'novel' })).toEqual([]);
    expect(await errorsFor(SuggestWebSerialsDto, { q: 'om', kind: 'manga' })).toEqual(['kind']);
    expect(await errorsFor(SuggestWebSerialsDto, { q: 'x'.repeat(201) })).toEqual(['q']);
    expect(await errorsFor(SuggestWebSerialsDto, {})).toEqual(['q']);
  });
});

describe('refresh flag', () => {
  it('accepts 1, true and 0 from the query string and rejects anything else', async () => {
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', refresh: '1' })).toEqual([]);
    expect(await errorsFor(SearchWebSerialsDto, { q: 'ab', refresh: 'true' })).toEqual([]);
    expect(await errorsFor(RefreshWebSerialsDto, { refresh: '0' })).toEqual([]);
    expect(await errorsFor(RefreshWebSerialsDto, {})).toEqual([]);
    expect(await errorsFor(RefreshWebSerialsDto, { refresh: 'yes' })).toEqual(['refresh']);
    expect(plainToInstance(RefreshWebSerialsDto, { refresh: '1' }).refresh).toBe(true);
  });
});

describe('SeriesMatchDto', () => {
  it('takes an optional numeric series-database id', async () => {
    expect(await errorsFor(SeriesMatchDto, {})).toEqual([]);
    expect(await errorsFor(SeriesMatchDto, { matchId: '1995' })).toEqual([]);
    expect(await errorsFor(SeriesMatchDto, { matchId: '19a5' })).toEqual(['matchId']);
    expect(await errorsFor(SeriesMatchDto, { matchId: '1'.repeat(13) })).toEqual(['matchId']);
  });
});

describe('ResolveWebSerialUrlDto', () => {
  it('accepts only http and https links', async () => {
    expect(await errorsFor(ResolveWebSerialUrlDto, { url: 'https://www.royalroad.com/fiction/1' })).toEqual([]);
    expect(await errorsFor(ResolveWebSerialUrlDto, { url: 'ftp://example.com/x' })).toEqual(['url']);
    expect(await errorsFor(ResolveWebSerialUrlDto, { url: 'javascript:alert(1)' })).toEqual(['url']);
    expect(await errorsFor(ResolveWebSerialUrlDto, { url: 'not a url' })).toEqual(['url']);
  });
});

describe('CreateWebSerialJobDto', () => {
  it('accepts all, range and list selections', async () => {
    expect(await errorsFor(CreateWebSerialJobDto, job)).toEqual([]);
    expect(
      await errorsFor(CreateWebSerialJobDto, {
        ...job,
        selection: { mode: 'range', fromSequence: '1', toSequence: '10.5' },
        skipImported: false,
        folderId: null,
        metadata: { matchId: '1995', authors: [' Kanehito Yamada '], artists: ['Tsukasa Abe'] },
      }),
    ).toEqual([]);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, selection: { mode: 'list', sequences: ['1', '10.5'] } })).toEqual([]);
  });

  it('rejects a bad key, packaging, range and unknown fields', async () => {
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, seriesKey: 'x:1' })).toEqual(['seriesKey']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, seriesKey: 'nl:novelbuddy:b21uaXNjaWVudC1yZWFkZXJz' })).toEqual([]);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, seriesKey: 'nl:novelbuddy:bad/path' })).toEqual(['seriesKey']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, packaging: 'book' })).toEqual(['packaging']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, selection: { mode: 'range', fromSequence: '1' } })).toEqual(['selection.toSequence']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, selection: { mode: 'range', fromSequence: '-1', toSequence: '2' } })).toEqual([
      'selection.fromSequence',
    ]);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, selection: { mode: 'list', sequences: [] } })).toEqual(['selection.sequences']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, selection: { mode: 'list', sequences: ['1', 'bad'] } })).toEqual(['selection.sequences']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, libraryId: 0 })).toEqual(['libraryId']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, userId: 9 })).toEqual(['userId']);
  });

  it('validates metadata overrides', async () => {
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { matchId: null, authors: ['A'], artists: ['B'] } })).toEqual([]);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { matchId: 'abc' } })).toEqual(['metadata.matchId']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { authors: [] } })).toEqual(['metadata.authors']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { authors: null } })).toEqual(['metadata.authors']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { artists: [' '] } })).toEqual(['metadata.artists']);
    expect(await errorsFor(CreateWebSerialJobDto, { ...job, metadata: { authors: Array.from({ length: 21 }, () => 'A') } })).toEqual([
      'metadata.authors',
    ]);
  });
});

describe('MoveWebSerialJobDto', () => {
  it('accepts a series key and rejects unknown fields', async () => {
    expect(await errorsFor(MoveWebSerialJobDto, { seriesKey: 'm:12' })).toEqual([]);
    expect(await errorsFor(MoveWebSerialJobDto, { seriesKey: 'bad' })).toEqual(['seriesKey']);
    expect(await errorsFor(MoveWebSerialJobDto, { seriesKey: 'm:12', source: 'x' })).toEqual(['source']);
  });
});

describe('ListWebSerialJobsDto', () => {
  it('caps the page size at 100', async () => {
    expect(await errorsFor(ListWebSerialJobsDto, { limit: '100', offset: '0' })).toEqual([]);
    expect(await errorsFor(ListWebSerialJobsDto, { limit: '101' })).toEqual(['limit']);
    expect(await errorsFor(ListWebSerialJobsDto, { offset: '-1' })).toEqual(['offset']);
  });
});

describe('job scope', () => {
  it('accepts mine and all, on the list and on clear-finished', async () => {
    expect(await errorsFor(ListWebSerialJobsDto, { scope: 'all', limit: '10' })).toEqual([]);
    expect(await errorsFor(ListWebSerialJobsDto, { scope: 'everyone' })).toEqual(['scope']);
    expect(await errorsFor(WebSerialJobScopeDto, {})).toEqual([]);
    expect(await errorsFor(WebSerialJobScopeDto, { scope: 'mine' })).toEqual([]);
    expect(await errorsFor(WebSerialJobScopeDto, { scope: 'x' })).toEqual(['scope']);
  });
});

describe('UpdateWebSerialNovelProvidersDto', () => {
  it('takes an array of up to 1000 domain strings', async () => {
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: [] })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: ['royalroad.com'] })).toEqual([]);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: Array.from({ length: 1001 }, (_, i) => `d${i}.com`) })).toEqual([
      'disabledDomains',
    ]);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: [1] })).toEqual(['disabledDomains']);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: ['x'.repeat(256)] })).toEqual(['disabledDomains']);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: 'a.com' })).toEqual(['disabledDomains']);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, {})).toEqual(['disabledDomains']);
    expect(await errorsFor(UpdateWebSerialNovelProvidersDto, { disabledDomains: [], extra: 1 })).toEqual(['extra']);
  });
});

describe('RecordWebSerialPublishedRequestDto', () => {
  const body = { kind: 'manga', matchId: '1995', volume: '2', bookRequestId: 9 };

  it('accepts a request for one volume of a series', async () => {
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, body)).toEqual([]);
  });

  it('rejects an unknown kind, a non-numeric id or volume, a bad request id and extra fields', async () => {
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, kind: 'comic' })).toEqual(['kind']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, matchId: 'abc' })).toEqual(['matchId']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, volume: '2a' })).toEqual(['volume']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, volume: '1000' })).toEqual(['volume']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, bookRequestId: 0 })).toEqual(['bookRequestId']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, bookRequestId: '9' })).toEqual(['bookRequestId']);
    expect(await errorsFor(RecordWebSerialPublishedRequestDto, { ...body, userId: 1 })).toEqual(['userId']);
  });
});

describe('ListWebSerialPublishedRequestsDto', () => {
  it('requires a kind and a series id', async () => {
    expect(await errorsFor(ListWebSerialPublishedRequestsDto, { kind: 'novel', matchId: '12' })).toEqual([]);
    expect(await errorsFor(ListWebSerialPublishedRequestsDto, {})).toEqual(['kind', 'matchId']);
  });
});

describe('route params', () => {
  it('takes a known kind and a numeric series-database id on discover routes', async () => {
    expect(await errorsFor(WebSerialDiscoverParamsDto, { kind: 'manga', matchId: '1995' })).toEqual([]);
    expect(await errorsFor(WebSerialDiscoverParamsDto, { kind: 'comic', matchId: '1995' })).toEqual(['kind']);
    expect(await errorsFor(WebSerialDiscoverParamsDto, { kind: 'novel', matchId: '19a5' })).toEqual(['matchId']);
  });

  it('takes only a well-formed series key on series routes', async () => {
    expect(await errorsFor(WebSerialSeriesKeyParamsDto, { seriesKey: 'm:123' })).toEqual([]);
    expect(await errorsFor(WebSerialSeriesKeyParamsDto, { seriesKey: 'nl:alpha:bi9ncm93' })).toEqual([]);
    expect(await errorsFor(WebSerialSeriesKeyParamsDto, { seriesKey: 'x:123' })).toEqual(['seriesKey']);
    expect(await errorsFor(WebSerialSeriesKeyParamsDto, { seriesKey: 'm:../etc' })).toEqual(['seriesKey']);
  });
});
