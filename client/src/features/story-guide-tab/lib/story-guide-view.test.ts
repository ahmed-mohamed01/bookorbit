import type { StoryGuideChronicle, StoryGuideChronicleTimelineEntry } from '@bookorbit/types'
import { describe, expect, it } from 'vitest'
import { buildConstellation } from './constellation'
import { end, fixtureCut, guideFixture, quote, rankFixture, timelineRow } from './story-guide.test-fixture'
import { anchorVisibility, buildStoryGuideView, previouslyByChapter } from './story-guide-view'

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
    expect(view.groups.people.map(({ name }) => name)).toEqual(['Ana', 'Ben', 'The Keeper'])
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
    expect(view.details('ana').notes.map(({ text }) => text)).toEqual(['Ana arrived.'])
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
    expect(legacy.entities.every(({ importance, mentions }) => importance === 2 && mentions === 0)).toBe(true)
    expect(legacy.groups.people.map(({ key }) => key)).toEqual(['ana', 'keeper', 'ben'])
    expect(legacy.timeline).toEqual([])
    expect(legacy.links).toEqual([])
    const locked = buildStoryGuideView(upstream, null, 'Opening')
    expect(locked.entities).toEqual([])
    expect(locked.chapters.every((chapter) => chapter.locked && !chapter.summaries.length)).toBe(true)
  })

  it('ranks a whole-book lead behind a more visible character until their evidence becomes visible', () => {
    const early = buildStoryGuideView(rankFixture, fixtureCut, 'Opening')
    const later = buildStoryGuideView(rankFixture, { s: 3, placedQuotes: [] }, 'Opening')
    const ranks = ({ groups }: ReturnType<typeof buildStoryGuideView>) =>
      groups.people.map(({ key, importance, mentions }) => [key, importance, mentions])

    expect(ranks(early)).toEqual([
      ['ben', 1, 2],
      ['ana', 3, 1],
    ])
    expect(ranks(later)).toEqual([
      ['ana', 1, 3],
      ['ben', 1, 2],
    ])
  })

  it('requires a quarter of the distinct visible rows and collapses adjacent rows of one chapter', () => {
    const chronicle = rankFixture.chronicle!
    const guide = {
      ...rankFixture,
      chronicle: {
        ...chronicle,
        entities: {
          ana: { about: [], timeline: [timelineRow(0, 'Arrival'), timelineRow(1, 'Arrival'), timelineRow(2)] },
          ben: { about: [], timeline: Array.from({ length: 9 }, (_, index) => timelineRow(index + 3)) },
        },
      },
    }
    expect(buildStoryGuideView(guide, { s: 9, placedQuotes: [] }, 'Opening').byKey.get('ana')).toMatchObject({ mentions: 2, importance: 1 })
    expect(buildStoryGuideView(guide, { s: 10, placedQuotes: [] }, 'Opening').byKey.get('ana')).toMatchObject({ mentions: 2, importance: 2 })
  })

  it('uses visible ties to order characters with the same rank and weight', () => {
    const [meeting, secret] = guideFixture.ties
    const chronicle = rankFixture.chronicle!
    const guide = {
      ...rankFixture,
      entities: [...rankFixture.entities, guideFixture.entities[2]!],
      ties: [
        { ...meeting!, a: 'gate' },
        { ...secret!, b: 'gate' },
      ],
      chronicle: { ...chronicle, entities: { ...chronicle.entities, ben: { about: [], timeline: [timelineRow(0)] } } },
    }
    const early = buildStoryGuideView(guide, fixtureCut, 'Opening')
    expect(early.groups.people.map(({ key }) => key)).toEqual(['ben', 'ana'])
    expect(early.groups.people.map(({ mentions }) => mentions)).toEqual([1, 1])
    expect(early.ties.map(({ key }) => key)).toEqual(['meeting'])
  })

  it('uses visible rank and weight for the constellation cap and star radii', () => {
    const [ana, ben] = rankFixture.entities
    const chronicle = rankFixture.chronicle!
    const contenders = Array.from({ length: 80 }, (_, index) => ({ ...ben!, key: `ben-${index}` }))
    const crowded = {
      ...rankFixture,
      entities: [ana!, ...contenders],
      chronicle: {
        ...chronicle,
        entities: {
          ana: chronicle.entities.ana!,
          ...Object.fromEntries(contenders.map(({ key }) => [key, chronicle.entities.ben!])),
        },
      },
    }

    const small = buildConstellation(buildStoryGuideView(rankFixture, fixtureCut, 'Opening'))
    expect(small.byKey.get('ana')?.radius).toBe(4)
    expect(small.byKey.get('ben')?.radius).toBe(9)

    const early = buildConstellation(buildStoryGuideView(crowded, fixtureCut, 'Opening'))
    const later = buildConstellation(buildStoryGuideView(crowded, { s: 3, placedQuotes: [] }, 'Opening'))
    expect(early.stars).toHaveLength(80)
    expect(early.byKey.has('ana')).toBe(false)
    expect(later.stars).toHaveLength(80)
    expect(later.stars[0]).toMatchObject({ entity: { key: 'ana', mentions: 3 }, radius: 9 })
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

  it('groups the recap by chapter, in reading order', () => {
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
      ['Opening', ['Front matter.']],
      ['Chapter 1: Into the Woods', ['The woods begin.', 'The woods end.']],
      ['Chapter 2: Up a Creek', ['The creek.']],
    ])
  })
})

describe('story guide extras', () => {
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

describe('story guide last seen', () => {
  const appearance = (through: number, at = through, chapter: string | null = null) => ({
    ...timelineRow(through, chapter),
    at: quote(at, `seen ${at}`),
  })
  function guideWith(timeline: StoryGuideChronicleTimelineEntry[], { joinTimeline = [] as StoryGuideChronicleTimelineEntry[], titles = true } = {}) {
    const viv = { ...guideFixture.entities[1]!, key: 'viv', name: 'Viv', names: [{ text: 'Viv', at: quote(0, 'arrived') }] }
    const join = { key: 'viviane', name: 'Viviane', at: quote(0, 'arrived'), names: [{ text: 'Viviane', at: quote(0, 'arrived') }], lines: [] }
    return {
      ...rankFixture,
      sections: Array.from({ length: 50 }, (_, s) => ({
        s,
        title: titles && s % 2 === 0 ? `Chapter ${s / 2 + 1}: A title` : null,
        chars: 100,
        h: 'h',
      })),
      entities: [{ ...viv, joins: joinTimeline.length ? [join] : [] }],
      chronicle: {
        version: 1,
        basis: rankFixture.builtAt,
        entities: { viv: { about: [], timeline }, ...(joinTimeline.length ? { viviane: { about: [], timeline: joinTimeline } } : {}) },
        joins: joinTimeline.length ? { viviane: quote(0, 'arrived') } : {},
      },
    } as typeof rankFixture
  }
  const lastSeen = (guide: typeof rankFixture, s: number) => buildStoryGuideView(guide, { s, placedQuotes: [] }, 'Opening').byKey.get('viv')?.lastSeen

  it('picks the latest visible appearance, including rows without a note', () => {
    expect(lastSeen(guideWith([appearance(10), appearance(8)]), 31)).toBe('Chapter 6')
  })

  it('ignores a row when either anchor is past the cut', () => {
    expect(lastSeen(guideWith([appearance(10), appearance(12, 30), appearance(30, 12)]), 30)).toBe('Chapter 6')
  })

  it('counts a merged join appearance', () => {
    expect(lastSeen(guideWith([appearance(10)], { joinTimeline: [appearance(12)] }), 32)).toBe('Chapter 7')
  })

  it('keeps Now at nine chapters and shows Last seen at ten', () => {
    const guide = guideWith([appearance(11)])
    expect(lastSeen(guide, 29)).toBeNull()
    expect(lastSeen(guide, 30)).toBe('Chapter 6')
  })

  it('uses the chronicle chapter range when present', () => {
    const guide = guideWith([appearance(10, 10, 'Ch 5-6')])
    expect(lastSeen(guide, 28)).toBeNull()
    expect(lastSeen(guide, 30)).toBe('Chapter 5-6')
  })

  it('uses the reader unit label when the chronicle establishes it', () => {
    expect(lastSeen(guideWith([appearance(10), appearance(32, 30, 'Ch 15')]), 30)).toBeNull()
  })

  it('keeps Now when the current chapter is unknown or nothing is visible', () => {
    expect(lastSeen(guideWith([appearance(10, 10, 'Ch 6')], { titles: false }), 30)).toBeNull()
    expect(lastSeen(guideWith([appearance(30)]), 30)).toBeNull()
  })
})
