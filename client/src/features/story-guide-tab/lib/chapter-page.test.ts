import { describe, expect, it } from 'vitest'
import { chapterPage, isChapterOrder, isChapterPageSize } from './chapter-page'

const chapters = Array.from({ length: 34 }, (_, index) => ({ title: `Chapter ${index + 1}` }))
const titles = (page: ReturnType<typeof chapterPage>) => page.chapters.map(({ title }) => title.replace('Chapter ', ''))

describe('chapter page', () => {
  it('starts newest first at the reader chapter, names the page by its chapters and holds the reader on page one', () => {
    const first = chapterPage(chapters, 'newest', 10, 1)
    expect(titles(first)).toEqual(['34', '33', '32', '31', '30', '29', '28', '27', '26', '25'])
    expect(first).toMatchObject({ page: 1, pages: 4, first: 'Chapter 34', last: 'Chapter 25', total: 34, holdsReader: true })
    const last = chapterPage(chapters, 'newest', 10, 4)
    expect(titles(last)).toEqual(['4', '3', '2', '1'])
    expect(last).toMatchObject({ first: 'Chapter 4', last: 'Chapter 1', holdsReader: false })
  })

  it('starts oldest first at the opening and holds the reader on the last page', () => {
    expect(chapterPage(chapters, 'oldest', 20, 1)).toMatchObject({ first: 'Chapter 1', last: 'Chapter 20', pages: 2, holdsReader: false })
    expect(chapterPage(chapters, 'oldest', 20, 2)).toMatchObject({ first: 'Chapter 21', last: 'Chapter 34', holdsReader: true })
  })

  it('clamps the page and keeps one empty page for a list without chapters', () => {
    expect(chapterPage(chapters, 'oldest', 50, 3)).toMatchObject({ page: 1, pages: 1, holdsReader: true })
    expect(chapterPage(chapters, 'newest', 10, 0).page).toBe(1)
    expect(chapterPage([], 'newest', 10, 1)).toMatchObject({ chapters: [], page: 1, pages: 1, first: '', last: '', holdsReader: true })
  })

  it('accepts only known orders and page sizes from storage', () => {
    expect(isChapterOrder('oldest')).toBe(true)
    expect(isChapterOrder('random')).toBe(false)
    expect(isChapterPageSize(20)).toBe(true)
    expect(isChapterPageSize(15)).toBe(false)
  })
})
