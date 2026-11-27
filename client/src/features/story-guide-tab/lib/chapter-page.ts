export type ChapterOrder = 'newest' | 'oldest'

/** A late cut on a long book holds thousands of notes, so only the reader's own choice of All renders more than 50 chapters. */
export const ALL_CHAPTERS = 0
export const CHAPTER_PAGE_SIZES = [10, 20, 50, ALL_CHAPTERS] as const
export type ChapterPageSize = (typeof CHAPTER_PAGE_SIZES)[number]
export const DEFAULT_CHAPTER_PAGE_SIZE: ChapterPageSize = CHAPTER_PAGE_SIZES[0]

export function isChapterOrder(value: unknown): value is ChapterOrder {
  return value === 'newest' || value === 'oldest'
}

export function isChapterPageSize(value: unknown): value is ChapterPageSize {
  return CHAPTER_PAGE_SIZES.includes(value as ChapterPageSize)
}

/** One page of `chapters`, which arrive in reading order. A page past either end clamps to the nearest one. */
export function chapterPage<T extends { title: string }>(chapters: readonly T[], order: ChapterOrder, size: number, page: number) {
  const perPage = size === ALL_CHAPTERS ? Math.max(1, chapters.length) : size
  const pages = Math.max(1, Math.ceil(chapters.length / perPage))
  const current = Math.min(Math.max(1, Math.floor(page)), pages)
  const ordered = order === 'newest' ? [...chapters].reverse() : chapters
  const shown = ordered.slice((current - 1) * perPage, current * perPage)
  return {
    chapters: shown,
    page: current,
    pages,
    first: shown[0]?.title ?? '',
    last: shown.at(-1)?.title ?? '',
    total: chapters.length,
    holdsReader: order === 'newest' ? current === 1 : current === pages,
  }
}

export type ChapterPage = ReturnType<typeof chapterPage>
