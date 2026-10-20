import { describe, expect, it } from 'vitest'
import { offFormatKind, preselectMissingUnits } from '../lib/lnAcquisition'
describe('acquisition helpers', () => {
  it.each([
    ['Novel (Manga)', [], 'manga'],
    ['Novel', ['cbr'], 'manga'],
    ['Novel audiobook', [], 'audiobook'],
    ['Novel', ['mp3'], 'audiobook'],
    ['Novel', ['epub'], null],
  ] as const)('classifies %s %j', (title, formats, kind) => {
    expect(offFormatKind({ title, formats: [...formats], format: null })).toBe(kind)
  })
  it('does not tick unknown, multi-volume or requested units', () => {
    const units = ['Unknown', 'Novel Vol. 1-2', 'Novel Vol. 1', 'Novel Vol. 2'].map((title, index) => ({
      index,
      title,
      mediaKind: 'ebook' as const,
      sizeBytes: null,
      primaryPath: title,
    }))
    expect([
      ...preselectMissingUnits(units, [
        { volume: 1, state: 'requested', bookId: null, error: null },
        { volume: 2, state: 'missing', bookId: null, error: null },
      ]),
    ]).toEqual([3])
  })
})
