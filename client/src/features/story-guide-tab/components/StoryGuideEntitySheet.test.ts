import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ForkStoryGuidePayload } from '@bookorbit/types'
import { end, guideFixture, quote } from '../lib/story-guide.test-fixture'
import { buildStoryGuideView } from '../lib/story-guide-view'
import StoryGuideEntitySheet from './StoryGuideEntitySheet.vue'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const sections = Array.from({ length: 8 }, (_, s) => ({ s, title: `Chapter ${s + 1}: Part`, chars: 100, h: 'h' }))
const guide: ForkStoryGuidePayload = {
  ...guideFixture,
  sections,
  entities: [{ ...guideFixture.entities[0]!, joins: [] }, guideFixture.entities[1]!],
  chronicle: {
    ...guideFixture.chronicle!,
    entities: {
      ana: {
        about: [],
        timeline: Array.from({ length: 6 }, (_, s) => ({ note: `Event ${s + 1}.`, at: quote(s, `q${s}`), through: end(s), chapter: null })),
      },
    },
  },
}

async function openSheet(key = 'ana') {
  const view = buildStoryGuideView(guide, { s: 7, placedQuotes: [] }, 'Opening')
  wrapper = mount(StoryGuideEntitySheet, { props: { entity: view.byKey.get(key), view }, attachTo: document.body })
  await flushPromises()
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
const rows = () =>
  [...dialog().querySelectorAll('[data-testid=story-guide-in-story-list] > div')].map((row) =>
    [...row.querySelectorAll(':scope > span:not([aria-hidden])')].map((part) => part.textContent!.trim()).join(' '),
  )
const click = async (testid: string) => {
  dialog().querySelector<HTMLButtonElement>(`[data-testid=${testid}]`)!.click()
  await flushPromises()
}

describe('StoryGuideEntitySheet', () => {
  it('shows the newest description in the card and the earlier ones folded in reading order', async () => {
    await openSheet()
    const card = dialog().querySelector<HTMLElement>('[data-testid=story-guide-what]')!
    expect(card.textContent).toContain('Who they are')
    expect(card.textContent).toContain('As of Chapter 2: Part')
    expect(card.textContent).toContain('Future profile')
    expect(card.textContent).toContain('2 earlier descriptions')
    expect(card.textContent).not.toContain('A traveler')
    await click('story-guide-earlier-descriptions')
    const earlier = [...card.querySelectorAll('li')].map((entry) => entry.textContent!.replace(/\s+/g, ' ').trim())
    expect(earlier).toEqual(['As of Chapter 1: Part A traveler', 'As of Chapter 2: Part A visitor'])
  })

  it('runs the Timeline from the first note to the reader', async () => {
    await openSheet()
    expect(rows()).toEqual([
      'Chapter 1: Part Event 1.',
      'Chapter 2: Part Event 2.',
      'Chapter 3: Part Event 3.',
      'Chapter 4: Part Event 4.',
      'Chapter 5: Part Event 5.',
      'Chapter 6: Part Event 6.',
    ])
    expect(dialog().querySelector('[data-testid=story-guide-in-story-here]')!.textContent).toContain('You are here, Chapter 8: Part')
    expect(dialog().querySelector('[data-testid=story-guide-display-all]')).toBeNull()
  })

  it('offers one Display all node when the list is cut off, and shows everything after it', async () => {
    const many = Array.from({ length: 50 }, (_, s) => ({ note: `Event ${s + 1}.`, at: quote(s % 6, `q${s}`), through: end(s % 6), chapter: null }))
    const view = buildStoryGuideView(
      { ...guide, chronicle: { ...guide.chronicle!, entities: { ana: { about: [], timeline: many } } } },
      { s: 7, placedQuotes: [] },
      'Opening',
    )
    wrapper = mount(StoryGuideEntitySheet, { props: { entity: view.byKey.get('ana'), view }, attachTo: document.body })
    await flushPromises()
    expect(dialog().querySelector('[data-testid=story-guide-display-all]')!.textContent).toContain('Display all 50 events')
    expect(dialog().querySelector('[data-testid=story-guide-in-story-here]')).toBeNull()
    await click('story-guide-display-all')
    expect(dialog().querySelectorAll('[data-testid=story-guide-in-story-list] > div')).toHaveLength(50)
    expect(dialog().querySelector('[data-testid=story-guide-display-all]')).toBeNull()
    expect(dialog().querySelector('[data-testid=story-guide-in-story-here]')).not.toBeNull()
  })

  it('flips the order and searches every note', async () => {
    await openSheet()
    await click('story-guide-note-order')
    expect(rows()[0]).toBe('Chapter 6: Part Event 6.')
    await click('story-guide-note-search')
    const input = dialog().querySelector<HTMLInputElement>('input[type=search]')!
    expect(document.activeElement).toBe(input)
    input.value = 'event 1'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows()).toEqual(['Chapter 1: Part Event 1.'])
    input.value = 'nothing like it'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(dialog().textContent).toContain('Nothing matches.')
    await click('story-guide-note-search')
    expect(rows()).toHaveLength(6)
  })

  it('puts ties on their own tab', async () => {
    await openSheet()
    expect(dialog().querySelector('[data-testid=story-guide-ties]')!.hasAttribute('hidden')).toBe(true)
    dialog()
      .querySelector<HTMLElement>('[data-testid=story-guide-tab-ties]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await flushPromises()
    expect(dialog().querySelector('[data-testid=story-guide-ties]')!.hasAttribute('hidden')).toBe(false)
    expect(dialog().querySelector('[data-testid=story-guide-in-story]')!.hasAttribute('hidden')).toBe(true)
  })

  it('calls a non-person entry What it is and leaves out In the story without notes', async () => {
    await openSheet('ben')
    expect(dialog().querySelector('[data-testid=story-guide-what]')!.textContent).toContain('Who they are')
    wrapper?.unmount()
    const view = buildStoryGuideView(guide, { s: 7, placedQuotes: [] }, 'Opening')
    wrapper = mount(StoryGuideEntitySheet, { props: { entity: { ...view.byKey.get('ben')!, kind: 'object' }, view }, attachTo: document.body })
    await flushPromises()
    expect(dialog().querySelector('[data-testid=story-guide-what]')!.textContent).toContain('What it is')
    expect(dialog().querySelector('[data-testid=story-guide-in-story]')).toBeNull()
  })
})
