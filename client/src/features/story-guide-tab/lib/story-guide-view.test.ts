import type { StoryGuideChronicle } from '@bookorbit/types'
import { describe, expect, it } from 'vitest'
import { buildConstellation } from './constellation'
import { end, fixtureCut, guideFixture, quote } from './story-guide.test-fixture'
import { anchorVisibility, buildStoryGuideView, PREVIOUSLY_CHAPTERS, previouslyByChapter } from './story-guide-view'

describe('story guide cut', () => {
  it('accepts earlier anchors and only server-placed quotes in the current section', () => {
    const visible = anchorVisibility(fixtureCut)
    expect(visible(end(0))).toBe(true)
    expect(visible(quote(1, 'gate opens', 900))).toBe(true)
    expect(visible(quote(1, 'unknown'))).toBe(false)
    expect(visible(end(1))).toBe(false)
    expect(visible(quote(2, 'gate opens'))).toBe(false)
    expect(visible(end(-1))).toBe(false)
    expect(anchorVisibility(null)(end(0))).toBe(false)
  })

  it('cuts every text source and keeps future chapter titles with locked rows', () => {
    const view = buildStoryGuideView(guideFixture, fixtureCut, 'Opening')
    expect(view.groups.people.map(({ name }) => name)).toEqual(['Ana', 'The Keeper', 'Ben'])
    expect(view.groups.places.map(({ name }) => name)).toEqual(['The gate'])
    expect(view.groups.terms).toEqual([])
    expect(view.byKey.get('ana')).toMatchObject({
      aliases: [{ name: 'Annie', s: 1 }],
      profiles: [
        { text: 'A visitor', s: 1 },
        { text: 'A traveler', s: 0 },
      ],
    })
    expect(view.ties.map(({ key, quotes }) => [key, quotes.length])).toEqual([
      ['meeting', 1],
      ['Keeper tie', 1],
    ])
    expect(view.links.map(({ score }) => score)).toEqual([0.75])
    expect(view.details('ana').groups.map(({ group }) => group)).toEqual(['friends-and-enemies', 'work-and-study'])
    expect([...view.details('ana').often].map(({ key }) => key)).toEqual(['gate'])
    expect(view.timeline.map(({ text }) => text)).toEqual(['Ana arrived.', 'The gate opens for Ben.'])
    expect(view.details('ana').recent.map(({ text }) => text)).toEqual(['Ana arrived.'])
    expect(view.chapters).toMatchObject([
      { title: 'Arrival', summaries: ['They arrived.'], locked: false },
      { title: 'At the gate', summaries: ['The gate opened.'], current: true, hidden: 1 },
      { title: 'The return', summaries: [], locked: true },
    ])
  })

  it('merges one event repeated per entity into one timeline note with every entity', () => {
    const chronicle = guideFixture.chronicle
    if (!chronicle) throw new Error('Missing chronicle fixture')
    const ben = chronicle.entities.ben!
    const merged = {
      ...guideFixture,
      chronicle: {
        ...chronicle,
        entities: {
          ...chronicle.entities,
          ben: { ...ben, timeline: [...ben.timeline, { note: '  Ana arrived. ', at: end(0), through: end(0), chapter: null }] },
          gate: { about: [], timeline: [{ note: 'Ana arrived.', at: quote(0, 'arrived'), through: end(0), chapter: null }] },
        },
      },
    }
    const view = buildStoryGuideView(merged, fixtureCut, 'Opening')
    expect(view.timeline.map(({ text, entities }) => [text, [...entities].map(({ key }) => key)])).toEqual([
      ['Ana arrived.', ['ana', 'ben', 'gate']],
      ['The gate opens for Ben.', ['ben']],
    ])
  })

  it('merges notes on the same quote anchor and orders a chapter by anchor', () => {
    const at = quote(0, 'arrived', 5)
    const chronicle: StoryGuideChronicle = {
      version: 1,
      basis: '2026-11-25T00:00:00Z',
      entities: {
        ana: {
          about: [],
          timeline: [
            { note: 'Later in the chapter.', at: quote(0, 'arrived', 50), through: end(0), chapter: null },
            { note: 'Ana meets Ben.', at, through: end(0), chapter: null },
          ],
        },
        ben: { about: [], timeline: [{ note: 'Ben meets Ana.', at, through: end(0), chapter: null }] },
      },
    }
    const view = buildStoryGuideView({ ...guideFixture, chronicle }, fixtureCut, 'Opening')
    expect(view.timeline.map(({ text, entities }) => [text, [...entities].map(({ key }) => key)])).toEqual([
      ['Ana meets Ben.', ['ana', 'ben']],
      ['Later in the chapter.', ['ana']],
    ])
    expect(view.chapters[0]!.notes).toHaveLength(2)
  })

  it('resolves joins at the cut, including an earlier chronicle join, without keeping self-ties', () => {
    const chronicle = guideFixture.chronicle
    if (!chronicle) throw new Error('Missing chronicle fixture')
    const view = buildStoryGuideView(
      { ...guideFixture, chronicle: { ...chronicle, joins: { keeper: quote(1, 'gate opens') } } },
      fixtureCut,
      'Opening',
    )
    expect(view.byKey.has('keeper')).toBe(false)
    expect(view.byKey.get('ana')?.aliases).toContainEqual({ name: 'The Keeper', s: 0 })
    expect(view.ties.map(({ key }) => key)).toEqual(['meeting'])
  })

  it('supports guides without extras and shows only locked chapters when no cut exists', () => {
    const { chronicle: _chronicle, links: _links, ...upstream } = guideFixture
    const legacy = buildStoryGuideView(upstream, fixtureCut, 'Opening')
    expect(legacy.entities).toHaveLength(4)
    expect(legacy.timeline).toEqual([])
    expect(legacy.links).toEqual([])
    const locked = buildStoryGuideView(upstream, null, 'Opening')
    expect(locked.entities).toEqual([])
    expect(locked.chapters.every((chapter) => chapter.locked && !chapter.summaries.length)).toBe(true)
  })

  it('caps the constellation at 80 and breaks importance ties by mention count', () => {
    const [first] = guideFixture.entities
    if (!first) throw new Error('Missing entity fixture')
    const entities = Array.from({ length: 100 }, (_, count) => ({ ...first, key: String(count), count, joins: [] }))
    const view = buildStoryGuideView({ ...guideFixture, entities }, fixtureCut, 'Opening')
    const graph = buildConstellation(view)
    expect(graph.stars).toHaveLength(80)
    expect(graph.stars[0]?.entity.mentions).toBe(99)
    expect(graph.stars.at(-1)?.entity.mentions).toBe(20)
  })
})

describe('story guide chapters', () => {
  const titles = [null, null, 'Chapter 1: Into the Woods', null, null, 'Chapter 2: Up a Creek', null, 'Chapter 3: Home']
  const grouped = {
    ...guideFixture,
    sections: titles.map((title, s) => ({ s, title, chars: 100, h: 'hash' })),
    entities: [
      { key: 'ana', name: 'Ana', kind: 'character' as const, names: [{ text: 'Ana', at: quote(4, 'ana') }], joins: [], lines: [], fixed: false },
    ],
    ties: [],
    links: [],
    chronicle: undefined,
    summaries: [
      { text: 'Front matter.', through: end(1) },
      { text: 'The woods begin.', through: end(3) },
      { text: 'Ana appears.', through: quote(4, 'ana', 5) },
      { text: 'The woods end.', through: end(4) },
      { text: 'The creek.', through: end(6) },
    ],
  }

  it('groups untitled sections into the chapter before and leads with an opening group', () => {
    const view = buildStoryGuideView(grouped, { s: 4, placedQuotes: ['ana'] }, 'Opening')
    expect(view.chapters.map(({ s, title }) => [s, title])).toEqual([
      [0, 'Opening'],
      [2, 'Chapter 1: Into the Woods'],
      [5, 'Chapter 2: Up a Creek'],
      [7, 'Chapter 3: Home'],
    ])
    expect(view.chapters.map(({ start }) => start)).toEqual([0, 25, 62.5, 87.5])
    expect(view.chapterTitle(3)).toBe('Chapter 1: Into the Woods')
    expect(view.chapterTitle(1)).toBe('Opening')
    expect(view.byKey.get('ana')?.firstSeen).toBe(4)
    expect(view.chapterTitle(view.byKey.get('ana')?.firstSeen ?? -1)).toBe('Chapter 1: Into the Woods')
  })

  it('opens the chapter holding the cut when the cut sits in a continuation section', () => {
    const view = buildStoryGuideView(grouped, { s: 4, placedQuotes: ['ana'] }, 'Opening')
    expect(view.currentChapter?.title).toBe('Chapter 1: Into the Woods')
    expect(view.chapters).toMatchObject([
      { title: 'Opening', locked: false, current: false, summaries: ['Front matter.'] },
      { locked: false, current: true, summaries: ['The woods begin.', 'Ana appears.'], hidden: 1 },
      { locked: true, current: false, summaries: [] },
      { locked: true, current: false, summaries: [] },
    ])
    expect(view.chapters.filter(({ locked }) => !locked)).toHaveLength(2)
  })

  it('keeps the opening group current while the reader is still before the first title', () => {
    const view = buildStoryGuideView(grouped, { s: 1, placedQuotes: [] }, 'Opening')
    expect(view.currentChapter?.title).toBe('Opening')
    expect(view.chapters.filter(({ locked }) => !locked).map(({ title }) => title)).toEqual(['Opening'])
    expect(view.chapters[0]).toMatchObject({ summaries: [], hidden: 1 })
  })

  it('starts with a titled chapter when the first section has a title', () => {
    const view = buildStoryGuideView({ ...grouped, sections: grouped.sections.slice(2).map((section) => ({ ...section })) }, null, 'Opening')
    expect(view.chapters.map(({ title }) => title)).toEqual(['Chapter 1: Into the Woods', 'Chapter 2: Up a Creek', 'Chapter 3: Home'])
  })

  it('groups the recap by chapter, newest chapter first and reading order inside', () => {
    const view = buildStoryGuideView(grouped, { s: 6, placedQuotes: [] }, 'Opening')
    const previously = previouslyByChapter(
      [
        { s: 1, title: null, text: 'Front matter.' },
        { s: 3, title: 'Chapter 1: Into the Woods', text: 'The woods begin.' },
        { s: 4, title: 'Chapter 1: Into the Woods', text: 'The woods end.' },
        { s: 6, title: 'Chapter 2: Up a Creek', text: 'The creek.' },
      ],
      view,
      'Opening',
    )
    expect(previously.map(({ title, summaries }) => [title, summaries])).toEqual([
      ['Chapter 2: Up a Creek', ['The creek.']],
      ['Chapter 1: Into the Woods', ['The woods begin.', 'The woods end.']],
      ['Opening', ['Front matter.']],
    ])
  })
})

describe('story guide extras', () => {
  it('keeps the newest four chapter groups under Previously', () => {
    const sections = Array.from({ length: 10 }, (_, s) => ({ s, title: `Part ${s + 1}`, chars: 100, h: 'h' }))
    const view = buildStoryGuideView({ ...guideFixture, sections }, { s: 9, placedQuotes: [] }, 'Opening')
    const previously = sections.map(({ s, title }) => ({ s, title, text: `Summary ${s}` }))
    const groups = previouslyByChapter(previously, view, 'Opening')
    expect(PREVIOUSLY_CHAPTERS).toBe(4)
    expect(groups.map(({ s }) => s)).toEqual([9, 8, 7, 6])
  })

  it('gives a tie the newest pair note the reader has reached, under either key order, and none before it', () => {
    const visible = buildStoryGuideView(guideFixture, fixtureCut, 'Opening')
    expect(visible.ties.find(({ key }) => key === 'meeting')?.note).toBe('Ana trusts Ben at the gate.')
    expect(visible.ties.find(({ key }) => key === 'Keeper tie')?.note).toBeNull()
    const reversed = {
      ...guideFixture,
      chronicle: { ...guideFixture.chronicle!, pairs: { 'ben|ana': guideFixture.chronicle!.pairs!['ana|ben'] } },
    }
    expect(buildStoryGuideView(reversed, fixtureCut, 'Opening').ties.find(({ key }) => key === 'meeting')?.note).toBe('Ana trusts Ben at the gate.')
    const beforePair = { s: 1, placedQuotes: ['gate opens'] }
    const early = {
      ...guideFixture,
      chronicle: { ...guideFixture.chronicle!, pairs: { 'ana|ben': [{ text: 'Future pair note', through: quote(1, 'gate closes', 40) }] } },
    }
    expect(buildStoryGuideView(early, beforePair, 'Opening').ties.find(({ key }) => key === 'meeting')?.note).toBeNull()
    expect(JSON.stringify(visible.ties)).not.toContain('Future pair note')
  })
})
