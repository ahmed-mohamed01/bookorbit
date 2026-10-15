import { describe, expect, it } from 'vitest'
import type { CreateBookRequestPayload, MetadataCandidate } from '@bookorbit/types'
import {
  buildMatchedVolumeRequest,
  MAX_VOLUME_SEARCH_QUERIES,
  pickVolumeCandidate,
  scoreVolumeCandidate,
  volumeSearchQueries,
} from '../lib/publishedVolumeMatch'
import type { PublishedSeries } from '../lib/publishedVolumes'

function series(overrides: Partial<PublishedSeries> = {}): PublishedSeries {
  return {
    kind: 'novel',
    matchId: '9102',
    title: 'The Water Magician',
    authors: ['Kubou Tadashi'],
    url: 'https://mangabaka.org/9102',
    publication: { licensed: true, finalVolume: 2, publishers: [] },
    ...overrides,
  }
}

function candidate(overrides: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    provider: 'google',
    providerId: 'g1',
    title: 'The Water Magician',
    displayTitle: 'The Water Magician: Volume 2',
    authors: ['Tadashi Kubou'],
    language: 'en',
    isbn13: '9781718300125',
    publishedYear: 2021,
    coverUrl: 'https://covers.example/2.jpg',
    seriesIndex: '2',
    ...overrides,
  }
}

describe('volumeSearchQueries', () => {
  it('tries the series title, then the same title without its subtitle', () => {
    const subtitled = series({ title: 'The Water Magician: The Central Provinces Arc' })
    expect(volumeSearchQueries(subtitled, 2)).toEqual([
      { title: 'The Water Magician: The Central Provinces Arc Vol. 2', author: 'Kubou Tadashi' },
      { title: 'The Water Magician Vol. 2', author: 'Kubou Tadashi' },
    ])
  })

  it('does not repeat a title that has no subtitle to strip', () => {
    expect(volumeSearchQueries(series(), 1)).toEqual([{ title: 'The Water Magician Vol. 1', author: 'Kubou Tadashi' }])
  })

  it('never asks more than the query cap, whatever the title looks like', () => {
    const shaped = series({ title: 'The Water Magician: The Central Provinces Arc' })
    for (const value of [series(), shaped, series({ title: 'Ai: The Long Climb' })]) {
      expect(volumeSearchQueries(value, 1).length).toBeLessThanOrEqual(MAX_VOLUME_SEARCH_QUERIES)
    }
    expect(MAX_VOLUME_SEARCH_QUERIES).toBe(3)
  })

  it('keeps the full title when the head before the colon is too short to be one', () => {
    expect(volumeSearchQueries(series({ title: 'Ai: The Long Climb' }), 1)).toEqual([{ title: 'Ai: The Long Climb Vol. 1', author: 'Kubou Tadashi' }])
  })

  it('searches without an author when the series lists none', () => {
    expect(volumeSearchQueries(series({ authors: [] }), 1)).toEqual([{ title: 'The Water Magician Vol. 1', author: null }])
  })
})

describe('scoreVolumeCandidate', () => {
  it('accepts an author whatever the name order is', () => {
    expect(scoreVolumeCandidate(candidate(), series(), 2)).not.toBeNull()
    expect(scoreVolumeCandidate(candidate({ authors: ['Someone Else'] }), series(), 2)).toBeNull()
  })

  it('accepts a candidate with no author only when the series lists none either', () => {
    const unnamed = candidate({ authors: [] })
    expect(scoreVolumeCandidate(unnamed, series(), 2)).toBeNull()
    const bare = scoreVolumeCandidate(unnamed, series({ authors: [] }), 2)
    expect(bare).not.toBeNull()
    expect(bare).toBeLessThan(scoreVolumeCandidate(candidate(), series(), 2)!)
  })

  it('reads the volume from the series index or the title', () => {
    expect(scoreVolumeCandidate(candidate({ seriesIndex: '02', displayTitle: 'Water Magician' }), series(), 2)).not.toBeNull()
    expect(scoreVolumeCandidate(candidate({ seriesIndex: undefined, displayTitle: 'The Water Magician 2' }), series(), 2)).not.toBeNull()
    expect(scoreVolumeCandidate(candidate({ seriesIndex: undefined, displayTitle: 'Water Magician #2' }), series(), 2)).not.toBeNull()
    expect(scoreVolumeCandidate(candidate({ seriesIndex: undefined, displayTitle: 'Water Magician' }), series(), 2)).toBeNull()
  })

  it('rejects a record of another volume, and one that disagrees with itself', () => {
    expect(scoreVolumeCandidate(candidate({ seriesIndex: '3' }), series(), 2)).toBeNull()
    expect(scoreVolumeCandidate(candidate({ seriesIndex: '2.5', displayTitle: 'Water Magician' }), series(), 2)).toBeNull()
    expect(scoreVolumeCandidate(candidate({ seriesIndex: '3', displayTitle: 'The Water Magician: Volume 2' }), series(), 2)).toBeNull()
  })

  it('rejects another series by the same author, and accepts records that name this series', () => {
    const subtitled = series({ title: 'The Water Magician: The Central Provinces Arc' })

    expect(scoreVolumeCandidate(candidate({ seriesIndex: '1', displayTitle: 'The Shield Hero: Volume 1' }), series(), 1)).toBeNull()

    const named = candidate({ seriesName: 'The Water Magician', seriesIndex: '1', displayTitle: 'Volume 1' })
    expect(scoreVolumeCandidate(named, subtitled, 1)).not.toBeNull()

    const titled = candidate({ seriesIndex: '1', displayTitle: 'The Water Magician: Volume 1' })
    expect(scoreVolumeCandidate(titled, subtitled, 1)).not.toBeNull()
  })

  it('prefers English over an unknown language, and an unknown one over another', () => {
    const english = scoreVolumeCandidate(candidate({ language: 'en' }), series(), 2)!
    const unknown = scoreVolumeCandidate(candidate({ language: undefined }), series(), 2)!
    const japanese = scoreVolumeCandidate(candidate({ language: 'ja' }), series(), 2)!
    expect(english).toBeGreaterThan(unknown)
    expect(unknown).toBeGreaterThan(japanese)
  })

  it('rejects a record with no title', () => {
    expect(scoreVolumeCandidate(candidate({ title: undefined, displayTitle: undefined }), series(), 2)).toBeNull()
  })
})

describe('pickVolumeCandidate', () => {
  it('picks the highest scoring record and keeps every accepted one for the request', () => {
    const better = candidate({ providerId: 'g9', isbn13: '9781718300125', coverUrl: 'https://covers.example/2.jpg' })
    const worse = candidate({ provider: 'openLibrary', providerId: 'o1', isbn13: undefined, coverUrl: undefined, publishedYear: undefined })
    const pick = pickVolumeCandidate([worse, better], series(), 2)

    expect(pick?.candidate.providerId).toBe('g9')
    expect(pick?.accepted.map((entry) => entry.providerId)).toEqual(['g9', 'o1'])
  })

  it('returns nothing when no record is the volume', () => {
    expect(pickVolumeCandidate([candidate({ seriesIndex: '7' })], series(), 2)).toBeNull()
    expect(pickVolumeCandidate([], series(), 2)).toBeNull()
  })
})

describe('buildMatchedVolumeRequest', () => {
  const destination = { libraryId: 4, folderId: 6, allowedFormats: ['epub'] }

  function payload(overrides: { candidate?: Partial<MetadataCandidate>; language?: string | null } = {}): CreateBookRequestPayload {
    const chosen = candidate(overrides.candidate)
    return buildMatchedVolumeRequest(chosen, {
      series: series(),
      volume: 2,
      destination,
      language: overrides.language === undefined ? 'en' : overrides.language,
      accepted: [chosen],
      providerLabel: (provider) => (provider === 'google' ? 'Google Books' : provider),
    })
  }

  it('builds the same fields the Requests page sends from a candidate', () => {
    expect(payload()).toEqual({
      title: 'The Water Magician: Volume 2',
      subtitle: null,
      authors: ['Tadashi Kubou'],
      seriesName: null,
      seriesIndex: 2,
      isbn10: null,
      isbn13: '9781718300125',
      publishedYear: 2021,
      language: 'en',
      coverUrl: 'https://covers.example/2.jpg',
      providerKey: 'google',
      providerId: 'g1',
      metadataSources: [{ providerKey: 'google', providerId: 'g1', providerLabel: 'Google Books', isbn10: null, isbn13: '9781718300125' }],
      note: 'MangaBaka: https://mangabaka.org/9102',
      mediaKind: 'ebook',
      targetLibraryId: 4,
      targetFolderId: 6,
      preferredFormats: ['epub'],
    })
  })

  it('narrows a series index the way the Requests page does', () => {
    expect(payload({ candidate: { seriesIndex: '1.5', displayTitle: 'The Water Magician: Volume 2' } }).seriesIndex).toBe(1)
  })

  it('keeps only a cover the request DTO accepts, and keeps the Web Serials destination', () => {
    expect(payload({ candidate: { coverUrl: '/covers/2.jpg' } }).coverUrl).toBeNull()
    expect(payload({ candidate: { coverUrl: 'ftp://covers.example/2.jpg' } }).coverUrl).toBeNull()
    expect(payload({ language: null }).language).toBeNull()
  })

  it('lists every accepted record once, with the provider label the Requests page would show', () => {
    const chosen = candidate()
    const built = buildMatchedVolumeRequest(chosen, {
      series: series({ kind: 'manga' }),
      volume: 2,
      destination: { libraryId: null, folderId: null, allowedFormats: [] },
      language: null,
      accepted: [chosen, { ...chosen, isbn13: undefined }, candidate({ provider: 'openLibrary', providerId: 'o1', isbn13: undefined })],
      providerLabel: (provider) => provider,
    })

    expect(built.metadataSources).toEqual([
      { providerKey: 'google', providerId: 'g1', providerLabel: 'google', isbn10: null, isbn13: '9781718300125' },
      { providerKey: 'openLibrary', providerId: 'o1', providerLabel: 'openLibrary', isbn10: null, isbn13: null },
    ])
    expect(built.targetLibraryId).toBeNull()
    expect(built.preferredFormats).toEqual(['cbz', 'epub'])
  })
})
