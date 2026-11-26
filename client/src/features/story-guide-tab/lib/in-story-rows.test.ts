import { describe, expect, it } from 'vitest'
import { inStoryRows, NOTES_BEFORE_EXPAND, NOTES_PER_EXPAND, shortChapterTitle } from './in-story-rows'

const notes = Array.from({ length: 30 }, (_, s) => ({ s, text: `Event ${s + 1}.` }))
const chapterTitle = (s: number) => `Chapter ${Math.floor(s / 2) + 1}: Part`
const options = { query: '', shown: NOTES_BEFORE_EXPAND, newestFirst: false, chapterTitle }
const summary = (rows: ReturnType<typeof inStoryRows>['rows']) =>
  rows.map((row) => (row.kind === 'note' ? `${row.chapter ?? '-'} ${row.note.text}` : row.kind === 'more' ? `more ${row.count}` : row.kind))

describe('in the story rows', () => {
  it('shortens chapter titles with a number and keeps any other title', () => {
    expect(shortChapterTitle('Chapter 13: The Cleansing')).toBe('Ch 13')
    expect(shortChapterTitle('Chap. XIV')).toBe('Ch XIV')
    expect(shortChapterTitle('Prologue')).toBe('Prologue')
  })

  it('shows the latest few oldest first with the expand control above and the reader below, naming each chapter once', () => {
    expect(summary(inStoryRows(notes, options).rows)).toEqual(['more 20', 'Ch 14 Event 28.', 'Ch 15 Event 29.', '- Event 30.', 'here'])
  })

  it('puts the reader first and the expand control last when newest first', () => {
    expect(summary(inStoryRows(notes, { ...options, newestFirst: true }).rows)).toEqual([
      'here',
      'Ch 15 Event 30.',
      '- Event 29.',
      'Ch 14 Event 28.',
      'more 20',
    ])
  })

  it('offers fewer once expanded and everything is shown', () => {
    const rows = inStoryRows(notes.slice(0, 10), { ...options, shown: NOTES_BEFORE_EXPAND + NOTES_PER_EXPAND }).rows
    expect(rows.map(({ kind }) => kind)).toEqual(['fewer', ...Array(10).fill('note'), 'here'])
  })

  it('searches notes and chapter titles, bounded, and never offers fewer while searching', () => {
    expect(summary(inStoryRows(notes, { ...options, query: 'ch 2' }).rows)).toEqual(['Ch 2 Event 3.', '- Event 4.', 'here'])
    const all = inStoryRows(notes, { ...options, query: 'event', shown: NOTES_PER_EXPAND })
    expect(all.matched).toBe(30)
    expect(summary(all.rows)[0]).toBe('more 10')
    expect(all.rows.some(({ kind }) => kind === 'fewer')).toBe(false)
    expect(inStoryRows(notes, { ...options, query: 'nothing' }).matched).toBe(0)
  })
})
