// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MetadataCandidate, MetadataSource } from '@bookorbit/types'
import {
  classifyDate,
  classifyDescription,
  classifyIdentifier,
  classifyLanguage,
  classifyList,
  classifyNumber,
  classifyOtherSeries,
  classifyRating,
  classifyText,
  descriptionPlainText,
  getCandidateList,
  otherSeriesAdditions,
  providerIdFieldFor,
  summarizeDifferences,
  withOtherSeries,
} from '../metadata-diff-fields'

describe('difference kinds', () => {
  it('reads an empty book field as a fill and an empty offer as missing', () => {
    expect(classifyText('', 'Dune')).toEqual({ kind: 'fill' })
    expect(classifyText('Dune', '  ')).toEqual({ kind: 'missing' })
  })

  it('tells capitalization and punctuation apart from a real change', () => {
    expect(classifyText('Dune', 'Dune')).toEqual({ kind: 'same' })
    expect(classifyText('Dune Messiah', 'dune messiah')).toEqual({ kind: 'minor', reason: 'capitalization' })
    expect(classifyText('Dune: Messiah', 'Dune Messiah')).toEqual({ kind: 'minor', reason: 'punctuation' })
    expect(classifyText('Miramax', 'Disney Hyperion')).toEqual({ kind: 'change' })
  })

  it('compares lists as sets, so the same genres in another order are only reordered', () => {
    expect(classifyList(['Fantasy', 'Fiction'], ['Fiction', 'Fantasy'])).toEqual({ kind: 'minor', reason: 'reordered' })
    expect(classifyList(['Fantasy'], ['fantasy'])).toEqual({ kind: 'minor', reason: 'capitalization' })
    expect(classifyList(['Fantasy'], ['Fantasy', 'Magic'])).toEqual({ kind: 'change' })
    expect(classifyList([], ['Magic'])).toEqual({ kind: 'fill' })
  })

  it('sees markup-only description changes as formatting', () => {
    expect(classifyDescription('<p>A <i>bold</i> start.</p>', 'A bold start.')).toEqual({ kind: 'minor', reason: 'formatting' })
    expect(classifyDescription('A bold start.', 'A timid start.')).toEqual({ kind: 'change' })
  })

  it('treats a bare year against a full date of the same year as minor', () => {
    expect(classifyDate('2003-04-01', '2003')).toEqual({ kind: 'minor', reason: 'yearOnly' })
    expect(classifyDate('2003', '2003-04-01')).toEqual({ kind: 'minor', reason: 'addsDay' })
    expect(classifyDate('2003-04-01', '2009-08-07')).toEqual({ kind: 'change' })
  })

  it('reads a language code and its name as the same language', () => {
    expect(classifyLanguage('English', 'en')).toEqual({ kind: 'minor', reason: 'languageCode' })
    expect(classifyLanguage('English', 'fr')).toEqual({ kind: 'change' })
  })

  it('compares numbers by value and identifiers without their separators', () => {
    expect(classifyNumber('1', 1)).toEqual({ kind: 'same' })
    expect(classifyNumber(396, 420)).toEqual({ kind: 'change' })
    expect(classifyIdentifier('978-1-4231-3217-2', '9781423132172')).toEqual({ kind: 'minor', reason: 'formatting' })
  })

  it('treats a new rating count with the same rating as minor', () => {
    expect(classifyRating({ rating: 4.4, ratingCount: 9846 }, { rating: 4.4, ratingCount: 9771 })).toEqual({ kind: 'minor', reason: 'ratingCount' })
    expect(classifyRating({ rating: 3.9, ratingCount: 10 }, { rating: 4.4, ratingCount: 10 })).toEqual({ kind: 'change' })
  })
})

describe('descriptionPlainText', () => {
  it('keeps paragraph breaks and decodes entities', () => {
    expect(descriptionPlainText('<p>She lost her daughter&nbsp;once.</p><p>Then&#8212;the letter &amp; more.</p>')).toBe(
      'She lost her daughter once.\n\nThen\u2014the letter & more.',
    )
  })
})

describe('summarizeDifferences', () => {
  const current: MetadataSource = {
    title: 'Artemis Fowl',
    subtitle: null,
    authors: ['Eoin Colfer'],
    genres: ['Fantasy', 'Fiction'],
    description: null,
    publisher: 'Miramax',
    publishedDate: '2003-04-01',
    publishedYear: 2003,
    language: 'English',
    pageCount: 396,
    seriesName: 'Artemis Fowl',
    seriesIndex: '1',
    isbn10: null,
    isbn13: null,
    narrators: [],
    durationSeconds: null,
    abridged: null,
    hardcoverEditionId: null,
    communityRatings: [],
  }

  it('counts fills and real changes, leaving minor differences out', () => {
    const candidate: MetadataCandidate = {
      provider: 'amazon',
      providerId: 'B002KP6DXQ',
      title: 'Artemis Fowl',
      authors: ['Eoin Colfer'],
      genres: ['Fiction', 'Fantasy'],
      publisher: 'Disney Hyperion',
      language: 'en',
      pageCount: 420,
      isbn13: '9781423132172',
    }

    expect(summarizeDifferences(current, candidate, { amazon: 'B002KP6DXQ' })).toEqual({ fills: 1, changes: 2 })
  })
})

describe('other series', () => {
  const book = {
    seriesName: 'Mistborn: The Original Trilogy',
    seriesMemberships: [
      { seriesName: 'Mistborn: The Original Trilogy', seriesIndex: '1' },
      { seriesName: 'The Cosmere', seriesIndex: null },
    ],
  } as MetadataSource
  const hardcover = {
    seriesName: 'The Mistborn Saga',
    seriesIndex: '1',
    seriesMemberships: [
      { seriesName: 'The Mistborn Saga', seriesIndex: '1' },
      { seriesName: 'Mistborn - The Original Trilogy', seriesIndex: '1' },
      { seriesName: 'the cosmere', seriesIndex: '4' },
      { seriesName: 'Cosmere Universe', seriesIndex: null },
    ],
  } as MetadataCandidate

  it("offers only series the book has under no spelling, leaving the result's own primary to its row", () => {
    expect(otherSeriesAdditions(book, hardcover)).toEqual([{ seriesName: 'Cosmere Universe', seriesIndex: null }])
    expect(classifyOtherSeries(book, hardcover)).toEqual({ kind: 'change' })
  })

  it('reads a book with no other series as a fill and a result with nothing new as the same', () => {
    expect(classifyOtherSeries({ seriesName: 'Mistborn: The Original Trilogy' } as MetadataSource, hardcover)).toEqual({ kind: 'fill' })
    expect(classifyOtherSeries({ ...book, seriesMemberships: [...book.seriesMemberships!, { seriesName: 'Cosmere Universe' }] }, hardcover)).toEqual({
      kind: 'same',
    })
    expect(classifyOtherSeries(book, { seriesName: 'The Mistborn Saga' } as MetadataCandidate)).toEqual({ kind: 'missing' })
  })

  it('shows a new series with its number and a shared one by name', () => {
    expect(getCandidateList(hardcover, 'otherSeries', book)).toEqual(['Mistborn - The Original Trilogy', 'the cosmere', 'Cosmere Universe'])
  })

  it('appends additions after the existing list without duplicates', () => {
    const merged = withOtherSeries(
      book.seriesMemberships!,
      [
        { seriesName: 'Cosmere Universe', seriesIndex: null },
        { seriesName: 'THE COSMERE', seriesIndex: '4' },
      ],
      { seriesName: 'Mistborn: The Original Trilogy', seriesIndex: '1' },
    )
    expect(merged.map((membership) => membership.seriesName)).toEqual(['Mistborn: The Original Trilogy', 'The Cosmere', 'Cosmere Universe'])
  })
})

describe('providerIdFieldFor', () => {
  it('keeps the id field of a source that moved out, and gives other external providers none', () => {
    expect(providerIdFieldFor('google')).toBe('googleBooksId')
    expect(providerIdFieldFor('lubimyczytac')).toBe('lubimyczytacId')
    expect(providerIdFieldFor('aladin')).toBe('aladinId')
    expect(providerIdFieldFor('fantlab')).toBeUndefined()
  })
})
