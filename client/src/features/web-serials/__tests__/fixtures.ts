import { defineComponent } from 'vue'
import type {
  WebSerialCatalogEntry,
  WebSerialJob,
  WebSerialJobItem,
  WebSerialSearchHit,
  WebSerialSeriesDetail,
  WebSerialSuggestion,
  WebSerialUnit,
} from '@bookorbit/types'

export function unit(sequence: string, overrides: Partial<WebSerialUnit> = {}): WebSerialUnit {
  return { key: `u${sequence}`, label: `Ch. ${sequence}`, sequence, chapterCount: 1, publishedAt: null, ...overrides }
}

export function mangaDetail(overrides: Partial<WebSerialSeriesDetail> = {}): WebSerialSeriesDetail {
  return {
    seriesKey: 'm:7',
    kind: 'manga',
    title: 'Tower Climber',
    author: 'Kim Lee',
    synopsis: 'A long climb.',
    tags: ['Action'],
    coverUrl: '/api/v1/web-serials/series/m%3A7/cover',
    sourceName: 'MangaDex',
    sourceUrl: null,
    status: 'ongoing',
    chapterCount: 5,
    units: ['1', '2', '3', '4', '5'].map((sequence) => unit(sequence)),
    packagingOptions: ['chapter'],
    defaultPackaging: 'chapter',
    importedUnitKeys: [],
    importedGroupKeys: [],
    ...overrides,
  }
}

export function novelDetail(overrides: Partial<WebSerialSeriesDetail> = {}): WebSerialSeriesDetail {
  return {
    seriesKey: 'n:3',
    kind: 'novel',
    title: 'The Long Night',
    author: 'A. Writer',
    synopsis: null,
    tags: [],
    coverUrl: null,
    sourceName: 'royalroad.com',
    sourceUrl: 'https://royalroad.com/fiction/1',
    status: 'unknown',
    chapterCount: 300,
    units: ['1', '2', '3'].map((sequence) => unit(sequence, { label: `Volume ${sequence}`, chapterCount: 100 })),
    packagingOptions: ['volume', 'series'],
    defaultPackaging: 'volume',
    importedUnitKeys: [],
    importedGroupKeys: [],
    ...overrides,
  }
}

export function catalogEntry(overrides: Partial<WebSerialCatalogEntry> = {}): WebSerialCatalogEntry {
  return {
    matchId: '1995',
    kind: 'manga',
    title: 'Frieren: Beyond Journey’s End',
    altTitles: [],
    authors: ['Kanehito Yamada'],
    artists: ['Tsukasa Abe'],
    year: 2020,
    status: 'ongoing',
    genres: ['Fantasy'],
    synopsis: 'An elf outlives her party.',
    coverUrl: '/api/v1/web-serials/discover/manga/1995/cover',
    url: 'https://mangabaka.org/1995',
    inLibrary: false,
    ...overrides,
  }
}

export function hit(overrides: Partial<WebSerialSearchHit> = {}): WebSerialSearchHit {
  return {
    seriesKey: 'm:7',
    url: null,
    kind: 'manga',
    title: 'Tower Climber',
    author: 'Kim Lee',
    coverUrl: null,
    sourceName: 'MangaDex',
    chapterCount: 42,
    status: 'ongoing',
    ...overrides,
  }
}

export function job(overrides: Partial<WebSerialJob> = {}): WebSerialJob {
  return {
    id: 1,
    kind: 'manga',
    seriesKey: 'm:7',
    title: 'Tower Climber',
    author: 'Kim Lee',
    coverUrl: null,
    sourceName: 'MangaDex',
    packaging: 'chapter',
    selection: { mode: 'all' },
    libraryId: 3,
    libraryName: 'Manga',
    status: 'running',
    unitsTotal: 10,
    unitsDone: 3,
    unitsFailed: 0,
    unitsSkipped: 1,
    current: null,
    message: null,
    queuePosition: null,
    canMoveToTop: false,
    owner: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

const passthrough = defineComponent({ template: '<div><slot /></div>' })

export const uiStubs = {
  Tooltip: passthrough,
  TooltipTrigger: passthrough,
  TooltipContent: { template: '<span />' },
  DropdownMenu: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuItem: defineComponent({ emits: ['select'], template: '<button type="button" @click="$emit(\'select\')"><slot /></button>' }),
}

export function jobItem(overrides: Partial<WebSerialJobItem> = {}): WebSerialJobItem {
  return { id: 1, label: 'Ch. 1', sequence: '1', status: 'pending', error: null, bookId: null, updatedAt: '2026-10-13T10:00:00.000Z', ...overrides }
}

export function suggestion(overrides: Partial<WebSerialSuggestion> = {}): WebSerialSuggestion {
  return {
    kind: 'novel',
    inLibrary: false,
    title: 'Omniscient Reader',
    cover: null,
    sourcesCount: 2,
    mtlOnly: false,
    entries: [{ sourceId: 'a', sourceName: 'Novel Fire', path: 'n/orv', mtl: false, seriesKey: 'nl:a:bi9vcnY' }],
    ...overrides,
  }
}
