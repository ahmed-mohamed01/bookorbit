import { describe, expect, it } from 'vitest'
import { cleanTags } from '../lib/serialTags'

describe('cleanTags', () => {
  it('strips prefixes, replaces underscores and title cases', () => {
    expect(cleanTags([], ['theme:slice_of_life', 'format:web_comic', 'sci-fi'])).toEqual(['Slice Of Life', 'Web Comic', 'Sci-Fi'])
  })

  it('puts genres first and dedupes ignoring case', () => {
    expect(cleanTags(['Action', 'Fantasy'], ['fantasy', 'theme:action', 'Pirates'])).toEqual(['Action', 'Fantasy', 'Pirates'])
  })

  it('drops blanks', () => {
    expect(cleanTags([' '], ['theme:', ''])).toEqual([])
  })

  it('does not capitalise the letter after an apostrophe', () => {
    expect(cleanTags([], ["don't_stop", "journey's end", "o'brien"])).toEqual(["Don't Stop", "Journey's End", "O'brien"])
  })
})
