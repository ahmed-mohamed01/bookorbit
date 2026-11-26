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

  it('runs In the story from the opening to the reader, showing the latest few until expanded', async () => {
    await openSheet()
    expect(rows()).toEqual(['Ch 4 Event 4.', 'Ch 5 Event 5.', 'Ch 6 Event 6.'])
    expect(dialog().querySelector('[data-testid=story-guide-note-more]')!.textContent).toContain('Show 3 earlier events')
    expect(dialog().querySelector('[data-testid=story-guide-in-story-here]')!.textContent).toContain('You are here, Chapter 8: Part')
    await click('story-guide-note-more')
    expect(rows()).toHaveLength(6)
    expect(rows()[0]).toBe('Ch 1 Event 1.')
    expect(dialog().querySelector('[data-testid=story-guide-note-more]')).toBeNull()
    await click('story-guide-note-fewer')
    expect(rows()).toHaveLength(3)
  })

  it('flips the order and searches every note, not only the shown few', async () => {
    await openSheet()
    await click('story-guide-note-order')
    expect(rows()).toEqual(['Ch 6 Event 6.', 'Ch 5 Event 5.', 'Ch 4 Event 4.'])
    await click('story-guide-note-search')
    const input = dialog().querySelector<HTMLInputElement>('input[type=search]')!
    expect(document.activeElement).toBe(input)
    input.value = 'event 1'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows()).toEqual(['Ch 1 Event 1.'])
    input.value = 'nothing like it'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(dialog().textContent).toContain('Nothing matches.')
    await click('story-guide-note-search')
    expect(rows()).toHaveLength(3)
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
