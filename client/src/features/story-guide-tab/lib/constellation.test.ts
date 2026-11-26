import { describe, expect, it } from 'vitest'
import { buildConstellation, CONSTELLATION_MAX_LINKS } from './constellation'
import type { EntityView, StoryGuideView } from './story-guide-view'

function entity(index: number): EntityView {
  return { key: `e${index}`, name: `E${index}`, kind: 'character', importance: 2, mentions: 1, firstSeen: 0, aliases: [], profiles: [], search: [] }
}

describe('buildConstellation', () => {
  it('draws only the 120 strongest links and never drops a tie', () => {
    const entities = Array.from({ length: 40 }, (_, index) => entity(index))
    const pairs = entities.flatMap((a, i) => entities.slice(i + 1).map((b) => [a, b] as const)).slice(0, 201)
    const ties = [{ a: pairs[0][0], b: pairs[0][1], quotes: [{ s: 0, end: true }] }]
    const links = pairs.map(([a, b], index) => ({ a, b, score: index }))
    const sky = buildConstellation({ entities, ties, links } as unknown as StoryGuideView)

    expect(sky.ties).toHaveLength(1)
    expect(sky.links).toHaveLength(CONSTELLATION_MAX_LINKS)
    expect(sky.links.map(({ weight }) => weight)).toEqual(Array.from({ length: CONSTELLATION_MAX_LINKS }, (_, index) => 200 - index))
  })

  it('keeps the same links for the same input order of equal weights', () => {
    const entities = Array.from({ length: 30 }, (_, index) => entity(index))
    const links = entities.flatMap((a, i) => entities.slice(i + 1).map((b) => ({ a, b, score: 1 })))
    const first = buildConstellation({ entities, ties: [], links } as unknown as StoryGuideView).links.map(({ key }) => key)
    const second = buildConstellation({ entities, ties: [], links: [...links].reverse() } as unknown as StoryGuideView).links.map(({ key }) => key)
    expect(first).toHaveLength(CONSTELLATION_MAX_LINKS)
    expect(second).toEqual(first)
  })
})
