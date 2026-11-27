/** Before "Display all", the sheet renders at most this many notes and clips them to the screen, so a long book stays cheap to open. */
export const NOTES_BEFORE_DISPLAY_ALL = 40

const CHAPTER_NUMBER = /^\s*(?:chapter|chap\.?|ch\.?)\s*(\d+|[IVXLCDM]+)\b/i

/** "Ch 13" for "Chapter 13: The Cleansing", so a search for "ch 13" finds it; any other title stays whole. */
export function shortChapterTitle(title: string) {
  const number = CHAPTER_NUMBER.exec(title)?.[1]
  return number ? `Ch ${number}` : title
}

export type InStoryRow<N> = { kind: 'note'; note: N; chapter: string | null; key: string } | { kind: 'here'; key: 'here' }

interface Options {
  query: string
  all: boolean
  newestFirst: boolean
  chapterTitle: (s: number) => string
}

/**
 * Rows in reading order for the screen and the keyboard alike, from the first note onwards in the chosen order.
 * The reader's mark closes an oldest-first list and opens a newest-first one; a cut-off oldest-first list leaves
 * it out. A note names its chapter only when the chapter changes from the row above.
 */
export function inStoryRows<N extends { s: number; text: string }>(notes: readonly N[], { query, all, newestFirst, chapterTitle }: Options) {
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle
    ? notes.filter(({ s, text }) => {
        const title = chapterTitle(s)
        return [text, title, shortChapterTitle(title)].some((value) => value.toLocaleLowerCase().includes(needle))
      })
    : notes
  const ordered = newestFirst ? [...matches].reverse() : matches
  const visible = all ? ordered : ordered.slice(0, NOTES_BEFORE_DISPLAY_ALL)
  let previous: string | undefined
  const noteRows = visible.map((note): InStoryRow<N> => {
    const title = chapterTitle(note.s)
    const chapter = title === previous ? null : title
    previous = title
    return { kind: 'note', note, chapter, key: `${note.s}:${note.text}` }
  })
  const hidden = matches.length - visible.length
  const here: InStoryRow<N> = { kind: 'here', key: 'here' }
  return {
    matched: matches.length,
    hidden,
    rows: newestFirst ? [here, ...noteRows] : hidden ? noteRows : [...noteRows, here],
  }
}
