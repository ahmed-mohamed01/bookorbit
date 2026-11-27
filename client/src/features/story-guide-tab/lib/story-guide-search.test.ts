import { describe, expect, it } from 'vitest'
import { highlightParts, searchStory } from './story-guide-search'
import { fixtureCut, guideFixture } from './story-guide.test-fixture'
import { buildStoryGuideView, type EntityGroup } from './story-guide-view'

const view = buildStoryGuideView(guideFixture, fixtureCut, 'Opening')
const all = new Set<EntityGroup>(['people', 'places', 'terms'])

describe('searchStory', () => {
  it('finds names, notes that say the words, and chapter summaries that say them', () => {
    const found = searchStory(view, 'gate', all)!
    expect(found.names.map(({ name }) => name)).toEqual(['The gate'])
    expect(found.timeline.flatMap(({ notes }) => notes.map(({ text }) => text))).toEqual(['The gate opens for Ben.'])
    expect(found.summaries).toEqual([expect.objectContaining({ title: 'At the gate', summaries: ['The gate opened.'] })])
  })

  it('finds a note through a tagged name whose alias matches', () => {
    const found = searchStory(view, 'annie', all)!
    expect(found.names.map(({ key }) => key)).toEqual(['ana'])
    expect(found.notes).toBe(1)
    expect(found.timeline[0]?.notes[0]?.text).toBe('Ana arrived.')
  })

  it('counts names for kinds that are off but leaves them out', () => {
    const found = searchStory(view, 'gate', new Set<EntityGroup>(['people']))!
    expect(found.names).toEqual([])
    expect(found.namesByGroup.places).toBe(1)
  })

  it('never matches past the cut and waits for two letters', () => {
    const future = searchStory(view, 'Future', all)!
    expect([future.names.length, future.notes, future.summaries.length]).toEqual([0, 0, 0])
    expect(searchStory(view, 'g', all)).toBeNull()
  })
})

describe('highlightParts', () => {
  it('marks every match regardless of case and treats the query as plain text', () => {
    expect(highlightParts('Gate and gate', 'GATE')).toEqual([
      { text: 'Gate', hit: true },
      { text: ' and ', hit: false },
      { text: 'gate', hit: true },
    ])
    expect(highlightParts('a (b) c', '(b)')).toEqual([
      { text: 'a ', hit: false },
      { text: '(b)', hit: true },
      { text: ' c', hit: false },
    ])
  })
})
