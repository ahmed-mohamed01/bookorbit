import { describe, expect, it } from 'vitest'
import { appendBoundedPage, type RetainedPage } from './bounded-page-retention'

type Item = { id: string }

const identity = (item: Item) => item.id
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }))

describe('appendBoundedPage', () => {
  it('keeps every page while the total stays at or under the cap', () => {
    const first = appendBoundedPage<Item>([], { page: 0, items: items('a', 'b') }, 2, 5, identity)
    expect(first.items.map(identity)).toEqual(['a', 'b'])
    expect(first.droppedOffset).toBe(0)

    const second = appendBoundedPage(first.pages, { page: 1, items: items('c', 'd') }, 2, 5, identity)
    expect(second.items.map(identity)).toEqual(['a', 'b', 'c', 'd'])
    expect(second.droppedOffset).toBe(0)
  })

  it('drops whole pages from the front once an append would exceed the cap', () => {
    const page0 = appendBoundedPage<Item>([], { page: 0, items: items('a', 'b') }, 2, 5, identity)
    const page1 = appendBoundedPage(page0.pages, { page: 1, items: items('c', 'd') }, 2, 5, identity)

    // 4 retained + 2 incoming = 6 > cap of 5; the oldest page (page 0, 2 items) is dropped whole.
    const page2 = appendBoundedPage(page1.pages, { page: 2, items: items('e', 'f') }, 2, 5, identity)

    expect(page2.items.map(identity)).toEqual(['c', 'd', 'e', 'f'])
    expect(page2.pages.map((p: RetainedPage<Item>) => p.page)).toEqual([1, 2])
    // page 1 is now the earliest retained page, at server offset 1 * pageSize.
    expect(page2.droppedOffset).toBe(2)
  })

  it('drops multiple front pages in one append when the incoming page alone pushes far past the cap', () => {
    let pages: RetainedPage<Item>[] = []
    let result = appendBoundedPage(pages, { page: 0, items: items('a', 'b') }, 2, 4, identity)
    pages = result.pages
    result = appendBoundedPage(pages, { page: 1, items: items('c', 'd') }, 2, 4, identity)
    pages = result.pages

    // 4 retained + 4 incoming = 8 > cap of 4; both earlier pages must go, not just one.
    result = appendBoundedPage(pages, { page: 2, items: items('e', 'f', 'g', 'h') }, 2, 4, identity)

    expect(result.items.map(identity)).toEqual(['e', 'f', 'g', 'h'])
    expect(result.pages).toHaveLength(1)
    expect(result.droppedOffset).toBe(4)
  })

  it('never drops the only remaining page, even if it alone exceeds the cap', () => {
    const result = appendBoundedPage<Item>([], { page: 0, items: items('a', 'b', 'c', 'd', 'e', 'f') }, 2, 3, identity)

    expect(result.items.map(identity)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(result.pages).toHaveLength(1)
    expect(result.droppedOffset).toBe(0)
  })

  it('dedupes an incoming item already retained before checking the cap', () => {
    const current: RetainedPage<Item>[] = [{ page: 0, items: items('a', 'b') }]

    const result = appendBoundedPage(current, { page: 1, items: items('b', 'c') }, 2, 10, identity)

    expect(result.items.map(identity)).toEqual(['a', 'b', 'c'])
    expect(result.pages).toEqual([
      { page: 0, items: items('a', 'b') },
      { page: 1, items: items('c') },
    ])
  })
})
