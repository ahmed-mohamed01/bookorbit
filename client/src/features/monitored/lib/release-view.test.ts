import { afterEach, describe, expect, it } from 'vitest'
import { isReleasedByUtcDate, releaseSectionOf, releaseCount, releaseGroup, releasesView } from './release-view'

const cards = { byStatus: 3, byWork: 2 }

describe('releaseCount', () => {
  afterEach(() => {
    releasesView.value = 'table'
    releaseGroup.value = 'status'
  })

  it('counts a row per format in the list view', () => {
    releasesView.value = 'table'
    expect(releaseCount(5, cards)).toBe(5)
  })

  it('counts the cards each grouping draws in the cards view', () => {
    releasesView.value = 'cards'
    releaseGroup.value = 'status'
    expect(releaseCount(5, cards)).toBe(3)
    releaseGroup.value = 'none'
    expect(releaseCount(5, cards)).toBe(2)
  })
})

describe('isReleasedByUtcDate', () => {
  it('treats today and partial dates already begun as released', () => {
    expect(isReleasedByUtcDate('2026-10-11', '2026-10-11')).toBe(true)
    expect(isReleasedByUtcDate('2026-10', '2026-10-11')).toBe(true)
    expect(isReleasedByUtcDate('2026-10-12', '2026-10-11')).toBe(false)
    expect(isReleasedByUtcDate('2026-11', '2026-10-11')).toBe(false)
  })
})

describe('releaseSectionOf', () => {
  it('puts a null date in undated and dated items by the UTC day', () => {
    expect(releaseSectionOf(null, '2026-10-11')).toBe('undated')
    expect(releaseSectionOf('2026-10-11', '2026-10-11')).toBe('released')
    expect(releaseSectionOf('2026-10-12', '2026-10-11')).toBe('upcoming')
  })
})
