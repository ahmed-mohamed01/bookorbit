import type { EntityView, StoryGuideView } from './story-guide-view'

/** Co-mention lines drawn at most: the strongest keep the sky readable and bound the work each star click does. */
export const CONSTELLATION_MAX_LINKS = 120

export function buildConstellation(view: StoryGuideView) {
  const entities = [...view.entities].sort((a, b) => a.importance - b.importance || b.mentions - a.mentions).slice(0, 80)
  const radii = { 1: 9, 2: 5.5, 3: 4 }
  const stars = entities.map((entity, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    const distance = Math.sqrt(index / Math.max(1, entities.length - 1))
    return {
      entity,
      x: 410 + Math.cos(angle) * distance * 310,
      y: 255 + Math.sin(angle) * distance * 207,
      radius: radii[entity.importance],
    }
  })
  const byKey = new Map(stars.map((star) => [star.entity.key, star]))
  type Edge = { key: string; a: (typeof stars)[number]; b: (typeof stars)[number]; weight: number }
  const ties = new Map<string, Edge>()
  const links = new Map<string, Edge>()

  function add(edges: Map<string, Edge>, a: EntityView, b: EntityView, weight: number) {
    const start = byKey.get(a.key)
    const end = byKey.get(b.key)
    if (!start || !end) return
    const key = JSON.stringify([a.key, b.key].sort())
    const edge = edges.get(key)
    if (edge) edge.weight += weight
    else edges.set(key, { key, a: start, b: end, weight })
  }

  for (const tie of view.ties) add(ties, tie.a, tie.b, tie.quotes.length)
  for (const link of view.links) add(links, link.a, link.b, link.score)
  const strongest = [...links.values()]
    .filter(({ key }) => !ties.has(key))
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1))
    .slice(0, CONSTELLATION_MAX_LINKS)
  return { stars, byKey, ties: [...ties.values()], links: strongest }
}
