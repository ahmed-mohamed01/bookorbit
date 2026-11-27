import { describe, expect, it } from 'vitest'
import { inStoryRows, NOTES_BEFORE_DISPLAY_ALL, shortChapterTitle } from './in-story-rows'

const notes = Array.from({ length: 60 }, (_, s) => ({ s, text: `Event ${s + 1}.` }))
const chapterTitle = (s: number) => `Chapter ${Math.floor(s / 2) + 1}: Part`
const options = { query: '', all: false, newestFirst: false, chapterTitle }
const summary = (rows: ReturnType<typeof inStoryRows>['rows']) =>
  rows.map((row) => (row.kind === 'note' ? `${row.chapter ?? '-'} ${row.note.text}` : row.kind))

describe('in the story rows', () => {
  it('shortens chapter titles with a number and keeps any other title', () => {
    expect(shortChapterTitle('Chapter 13: The Cleansing')).toBe('Ch 13')
    expect(shortChapterTitle('Chap. XIV')).toBe('Ch XIV')
    expect(shortChapterTitle('Prologue')).toBe('Prologue')
  })

  it('starts at the first note, naming each chapter once, and ends at the reader when nothing is cut off', () => {
    expect(summary(inStoryRows(notes.slice(0, 3), options).rows)).toEqual([
      'Chapter 1: Part Event 1.',
      '- Event 2.',
      'Chapter 2: Part Event 3.',
      'here',
    ])
  })

  it('renders a bounded start until Display all, then every note and the reader', () => {
    const collapsed = inStoryRows(notes, options)
    expect(collapsed.rows).toHaveLength(NOTES_BEFORE_DISPLAY_ALL)
    expect(collapsed.hidden).toBe(60 - NOTES_BEFORE_DISPLAY_ALL)
    expect(summary(collapsed.rows)[0]).toBe('Chapter 1: Part Event 1.')
    expect(collapsed.rows.some(({ kind }) => kind === 'here')).toBe(false)
    const all = inStoryRows(notes, { ...options, all: true })
    expect(all.hidden).toBe(0)
    expect(all.rows).toHaveLength(61)
    expect(all.rows.at(-1)!.kind).toBe('here')
  })

  it('puts the reader first and runs back from the newest note when newest first', () => {
    expect(summary(inStoryRows(notes, { ...options, newestFirst: true }).rows).slice(0, 4)).toEqual([
      'here',
      'Chapter 30: Part Event 60.',
      '- Event 59.',
      'Chapter 29: Part Event 58.',
    ])
  })

  it('searches notes and chapter titles', () => {
    expect(summary(inStoryRows(notes, { ...options, query: 'ch 2' }).rows).slice(0, 2)).toEqual(['Chapter 2: Part Event 3.', '- Event 4.'])
    expect(inStoryRows(notes, { ...options, query: 'event' }).matched).toBe(60)
    expect(inStoryRows(notes, { ...options, query: 'nothing' }).matched).toBe(0)
  })
})
