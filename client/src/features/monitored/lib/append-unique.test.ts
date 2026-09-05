import { describe, expect, it } from 'vitest'
import { appendUnique } from './append-unique'

describe('appendUnique', () => {
  const identity = (item: { id: string }) => item.id

  it('drops incoming rows already on screen after an offset shift', () => {
    const current = [{ id: 'a' }, { id: 'b' }]
    const incoming = [{ id: 'b' }, { id: 'c' }]

    expect(appendUnique(current, incoming, identity)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })

  it('keeps the first copy when a page repeats an id within itself', () => {
    expect(appendUnique([], [{ id: 'a' }, { id: 'a' }, { id: 'b' }], identity)).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('supports a composite identity such as a release work and format', () => {
    const key = (item: { workId: string; format: string }) => `${item.workId}:${item.format}`
    const current = [{ workId: 'w1', format: 'ebook' }]
    const incoming = [
      { workId: 'w1', format: 'ebook' },
      { workId: 'w1', format: 'audiobook' },
    ]

    expect(appendUnique(current, incoming, key)).toEqual([
      { workId: 'w1', format: 'ebook' },
      { workId: 'w1', format: 'audiobook' },
    ])
  })

  it('returns a new array and leaves the current page untouched', () => {
    const current = [{ id: 'a' }]
    const merged = appendUnique(current, [{ id: 'b' }], identity)

    expect(merged).not.toBe(current)
    expect(current).toEqual([{ id: 'a' }])
  })
})
