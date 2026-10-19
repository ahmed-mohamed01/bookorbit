import { describe, expect, it } from 'vitest'
import type { BookRequestItem, BookRequestStatus, WebSerialPublication } from '@bookorbit/types'
import {
  buildVolumeRequest,
  buildVolumeRows,
  clampVolumeCount,
  isVolumeMissing,
  preferredFormatsFor,
  resolveVolumeCount,
  volumeTitle,
  type PublishedSeries,
} from '../lib/publishedVolumes'

/** Every field `CreateBookRequestDto` declares. Anything else is refused by `forbidNonWhitelisted`. */
const CREATE_BOOK_REQUEST_DTO_FIELDS = [
  'userId',
  'title',
  'subtitle',
  'authors',
  'seriesName',
  'seriesIndex',
  'isbn10',
  'isbn13',
  'publishedYear',
  'language',
  'coverUrl',
  'selfServe',
  'autoGrab',
  'deferAutomation',
  'providerKey',
  'providerId',
  'metadataSources',
  'note',
  'mediaKind',
  'preferredFormats',
  'targetLibraryId',
  'targetFolderId',
  'targetBookId',
]

function publication(overrides: Partial<WebSerialPublication> = {}): WebSerialPublication {
  return { licensed: true, finalVolume: null, publishers: [], ...overrides }
}

function series(overrides: Partial<PublishedSeries> = {}): PublishedSeries {
  return {
    kind: 'manga',
    matchId: '1234',
    title: 'Spice and Wolf',
    authors: ['Isuna Hasekura'],
    url: 'https://mangabaka.org/1234',
    publication: publication(),
    ...overrides,
  }
}

function request(overrides: Partial<BookRequestItem> = {}): BookRequestItem {
  return {
    id: 1,
    userId: 1,
    requesterUsername: 'me',
    requesterName: 'Me',
    mediaKind: 'ebook',
    status: 'pending',
    title: 'Spice and Wolf Vol. 1',
    subtitle: null,
    authors: [],
    seriesName: 'Spice and Wolf',
    seriesIndex: 1,
    isbn10: null,
    isbn13: null,
    publishedYear: null,
    language: null,
    coverUrl: null,
    providerKey: null,
    providerId: null,
    metadataSources: [],
    preferredFormats: [],
    note: null,
    targetLibraryId: null,
    targetLibraryName: null,
    targetFolderId: null,
    decidedByUserId: null,
    decidedByUsername: null,
    decidedAt: null,
    decisionNote: null,
    matchedBookId: null,
    bookDockFileId: null,
    kind: 'single',
    batch: null,
    selfServe: false,
    fulfillerUserId: null,
    statusReason: null,
    failureCode: null,
    failureMeta: null,
    subscribers: [],
    download: null,
    dismissed: false,
    companionRequestId: null,
    targetBookId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('volume count', () => {
  it('takes the final volume from the series database over anything typed', () => {
    expect(resolveVolumeCount(publication({ finalVolume: 7 }), 30)).toBe(7)
  })

  it('falls back to the typed count, bounded to 1..200', () => {
    expect(resolveVolumeCount(publication(), 12)).toBe(12)
    expect(resolveVolumeCount(null, 12)).toBe(12)
    expect(resolveVolumeCount(publication(), 999)).toBe(200)
    expect(resolveVolumeCount(publication(), 0)).toBeNull()
    expect(resolveVolumeCount(publication(), null)).toBeNull()
    expect(clampVolumeCount(Number.NaN)).toBeNull()
    expect(clampVolumeCount(4.7)).toBe(4)
  })

  it('caps a very long print run at the same bound', () => {
    expect(resolveVolumeCount(publication({ finalVolume: 250 }), null)).toBe(200)
  })
})

describe('buildVolumeRequest', () => {
  it('matches the shape the server test validates against CreateBookRequestDto', () => {
    const payload = buildVolumeRequest(series(), 3, { libraryId: 4, folderId: 9, allowedFormats: [] })

    // Kept identical to WEB_SERIAL_VOLUME_REQUEST in server/src/modules/book-request/dto/create-book-request.dto.test.ts.
    expect(payload).toEqual({
      title: 'Spice and Wolf Vol. 3',
      seriesName: 'Spice and Wolf',
      seriesIndex: 3,
      mediaKind: 'ebook',
      preferredFormats: ['cbz', 'epub'],
      note: 'MangaBaka: https://mangabaka.org/1234',
      authors: ['Isuna Hasekura'],
      targetLibraryId: 4,
      targetFolderId: 9,
    })
    for (const key of Object.keys(payload)) expect(CREATE_BOOK_REQUEST_DTO_FIELDS).toContain(key)
  })

  it('never names the series as the provider, so volumes do not fold into one request', () => {
    const payload = buildVolumeRequest(series(), 2, { libraryId: null, folderId: null, allowedFormats: [] })
    expect(payload).not.toHaveProperty('providerKey')
    expect(payload).not.toHaveProperty('providerId')
    expect(payload).not.toHaveProperty('metadataSources')
    expect(payload).not.toHaveProperty('coverUrl')
  })

  it('leaves the destination to the server when Web Serials has no default library', () => {
    const payload = buildVolumeRequest(series({ authors: [' '] }), 1, { libraryId: null, folderId: 3, allowedFormats: [] })
    expect(payload).not.toHaveProperty('targetLibraryId')
    expect(payload).not.toHaveProperty('targetFolderId')
    expect(payload).not.toHaveProperty('authors')
  })

  it('asks for EPUB for a novel', () => {
    expect(buildVolumeRequest(series({ kind: 'novel' }), 1, { libraryId: 1, folderId: null, allowedFormats: [] }).preferredFormats).toEqual(['epub'])
  })

  it('names volumes the same way every time', () => {
    expect(volumeTitle(' Spice and Wolf ', 12)).toBe('Spice and Wolf Vol. 12')
  })
})

describe('preferredFormatsFor', () => {
  it('keeps only what the target library accepts', () => {
    expect(preferredFormatsFor('manga', ['epub', 'pdf'])).toEqual(['epub'])
    expect(preferredFormatsFor('manga', ['cbz'])).toEqual(['cbz'])
    expect(preferredFormatsFor('novel', ['epub'])).toEqual(['epub'])
  })

  it('falls back to the first choice when the library accepts none of them', () => {
    expect(preferredFormatsFor('manga', ['pdf'])).toEqual(['cbz'])
  })
})

describe('status mapping', () => {
  it('builds one row per volume and marks the ones still worth requesting', () => {
    const rows = buildVolumeRows(3, new Map([[2, request({ seriesIndex: 2 })]]))
    expect(rows.map((row) => [row.volume, row.request?.id ?? null])).toEqual([
      [1, null],
      [2, 1],
      [3, null],
    ])
    expect(buildVolumeRows(null, new Map())).toEqual([])

    const statuses: [BookRequestStatus, boolean][] = [
      ['pending', false],
      ['approved', false],
      ['downloading', false],
      ['available', false],
      ['failed', false],
      ['cancelled', true],
      ['rejected', true],
    ]
    for (const [status, missing] of statuses) expect(isVolumeMissing({ volume: 1, request: request({ status }) })).toBe(missing)
    expect(isVolumeMissing({ volume: 1, request: null })).toBe(true)
  })
})
