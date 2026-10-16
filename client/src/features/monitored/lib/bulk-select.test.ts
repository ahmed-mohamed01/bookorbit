import { describe, expect, it } from 'vitest'
import { chunk, bulkRequestPreview, isMissing, isReleased } from './bulk-select'
import { TODAY, workFixture } from '../testing/work-fixture'

const missing = workFixture({ id: 'missing' })
const owned = workFixture({ id: 'owned', ownedFormats: ['ebook'] })
const requested = workFixture({ id: 'requested', requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } })
const audioOnly = workFixture({ id: 'audio-only', ebookReleaseDate: null, ebookDatePrecision: null })
const upcoming = workFixture({ id: 'upcoming', ebookReleaseDate: '2999-01-01', audioReleaseDate: '2999-01-01' })

describe('bulkRequestPreview', () => {
  it('counts what will be requested and why the rest is skipped', () => {
    const preview = bulkRequestPreview([missing, owned, requested, audioOnly], 'ebook', TODAY)

    expect(preview.ebooks).toBe(1)
    expect(preview.audiobooks).toBe(0)
    expect(preview.skipped).toEqual({ owned: 1, requested: 1, no_ebook: 1 })
  })

  it('previews both formats of a work independently', () => {
    const preview = bulkRequestPreview([owned, missing], 'both', TODAY)

    expect(preview.ebooks).toBe(1)
    expect(preview.audiobooks).toBe(2)
    expect(preview.skipped.owned).toBe(1)
  })

  it('counts an upcoming format as requestable, as the server does', () => {
    expect(bulkRequestPreview([upcoming], 'audiobook', TODAY).audiobooks).toBe(1)
  })

  it('is empty for no works', () => {
    expect(bulkRequestPreview([], 'both', TODAY)).toEqual({ ebooks: 0, audiobooks: 0, skipped: { owned: 0, requested: 0, no_ebook: 0 } })
  })
})

describe('quick select predicates', () => {
  it('treats a released, unowned, watched format as missing', () => {
    expect(isMissing(missing, 'ebook', TODAY)).toBe(true)
    expect(isMissing(owned, 'ebook', TODAY)).toBe(false)
    expect(isMissing(requested, 'ebook', TODAY)).toBe(false)
    expect(isMissing(upcoming, 'ebook', TODAY)).toBe(false)
  })

  it('reads release from the format release window', () => {
    expect(isReleased(missing, 'audiobook', TODAY)).toBe(true)
    expect(isReleased(upcoming, 'ebook', TODAY)).toBe(false)
    expect(isReleased(audioOnly, 'ebook', TODAY)).toBe(false)
  })
})

describe('chunk', () => {
  it('splits at the size and keeps order', () => {
    const ids = Array.from({ length: 250 }, (_, index) => String(index))

    const chunks = chunk(ids, 100)

    expect(chunks.map((group) => group.length)).toEqual([100, 100, 50])
    expect(chunks.flat()).toEqual(ids)
  })

  it('defaults to the bulk limit and returns nothing for nothing', () => {
    expect(chunk(Array.from({ length: 101 }, (_, index) => index)).map((group) => group.length)).toEqual([100, 1])
    expect(chunk([])).toEqual([])
  })
})
