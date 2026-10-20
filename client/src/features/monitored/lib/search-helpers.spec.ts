import { describe, expect, it } from 'vitest'
import { watchedFormats } from './monitored-format-state'
import { isSearchReady } from './search-query'

describe('Watchlist search helpers', () => {
  it('watches formats unless their author mode is off', () => {
    expect(watchedFormats({ ebook: 'off' })).toEqual(['audiobook'])
    expect(watchedFormats({ ebook: 'notify', audiobook: 'off' })).toEqual(['ebook'])
    expect(watchedFormats({})).toEqual(['ebook', 'audiobook'])
  })
  it('requires three trimmed code points', () => {
    expect(isSearchReady(' 😀a ')).toBe(false)
    expect(isSearchReady(' 😀ab ')).toBe(true)
  })
})
