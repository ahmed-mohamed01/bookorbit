import { appendUnique } from './append-unique'

export interface RetainedPage<T> {
  page: number
  items: T[]
}

export interface RetainedPageWindow<T> {
  pages: RetainedPage<T>[]
  items: T[]
  droppedOffset: number
}

/**
 * Keeps the newest complete server pages. Page boundaries matter because removing an arbitrary
 * slice can leave a partial page that cannot be reconstructed from its server offset.
 */
export function appendBoundedPage<T>(
  currentPages: readonly RetainedPage<T>[],
  incomingPage: RetainedPage<T>,
  pageSize: number,
  maxItems: number,
  identity: (item: T) => string,
): RetainedPageWindow<T> {
  const currentItems = currentPages.flatMap((page) => page.items)
  const merged = appendUnique(currentItems, incomingPage.items, identity)
  const uniqueIncoming = merged.slice(currentItems.length)
  const pages = [...currentPages, { ...incomingPage, items: uniqueIncoming }]
  let retainedCount = merged.length

  while (retainedCount > maxItems && pages.length > 1) {
    const dropped = pages.shift()
    retainedCount -= dropped?.items.length ?? 0
  }

  const items = pages.flatMap((page) => page.items)
  return {
    pages,
    items,
    droppedOffset: (pages[0]?.page ?? 0) * pageSize,
  }
}
