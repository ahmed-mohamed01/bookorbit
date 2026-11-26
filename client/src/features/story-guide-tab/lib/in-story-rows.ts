/** "In the story" on an entry's sheet: the latest few notes show, and each expand or search shows at most a step more. */
export const NOTES_BEFORE_EXPAND = 3
export const NOTES_PER_EXPAND = 20

const CHAPTER_NUMBER = /^\s*(?:chapter|chap\.?|ch\.?)\s*(\d+|[IVXLCDM]+)\b/i

/** The narrow node column reads "Ch 13" for "Chapter 13: The Cleansing"; any other title stays whole. */
export function shortChapterTitle(title: string) {
  const number = CHAPTER_NUMBER.exec(title)?.[1]
  return number ? `Ch ${number}` : title
}

export type InStoryRow<N> =
  | { kind: 'note'; note: N; chapter: string | null; key: string }
  | { kind: 'more'; count: number; key: 'more' }
  | { kind: 'fewer'; key: 'fewer' }
  | { kind: 'here'; key: 'here' }

interface Options {
  query: string
  shown: number
  newestFirst: boolean
  chapterTitle: (s: number) => string
}

/**
 * Rows in reading order for the screen and the keyboard alike: oldest first runs expand control, notes, the
 * reader; newest first runs the reader, notes, expand control. A note names its chapter only when the
 * chapter changes from the row above.
 */
export function inStoryRows<N extends { s: number; text: string }>(notes: readonly N[], { query, shown, newestFirst, chapterTitle }: Options) {
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle
    ? notes.filter(({ s, text }) => {
        const title = chapterTitle(s)
        return [text, title, shortChapterTitle(title)].some((value) => value.toLocaleLowerCase().includes(needle))
      })
    : notes
  const visible = matches.slice(-Math.max(1, shown))
  const ordered = newestFirst ? [...visible].reverse() : visible
  let previous: string | undefined
  const noteRows = ordered.map((note): InStoryRow<N> => {
    const title = chapterTitle(note.s)
    const chapter = title === previous ? null : shortChapterTitle(title)
    previous = title
    return { kind: 'note', note, chapter, key: `${note.s}:${note.text}` }
  })
  const hidden = matches.length - visible.length
  const control: InStoryRow<N>[] = hidden
    ? [{ kind: 'more', count: Math.min(hidden, NOTES_PER_EXPAND), key: 'more' }]
    : !needle && visible.length > NOTES_BEFORE_EXPAND
      ? [{ kind: 'fewer', key: 'fewer' }]
      : []
  const here: InStoryRow<N> = { kind: 'here', key: 'here' }
  return {
    matched: matches.length,
    rows: newestFirst ? [here, ...noteRows, ...control] : [...control, ...noteRows, here],
  }
}
