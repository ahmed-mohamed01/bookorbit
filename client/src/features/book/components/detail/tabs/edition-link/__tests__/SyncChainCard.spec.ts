import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChainCardRow, ChainFrame, ChainViewMode } from '@/features/book/lib/sync-chain'
import EditionCover from '../EditionCover.vue'
import SyncChainCard from '../SyncChainCard.vue'
import { absLive, cardRow, chainAbs, chainEdition, chainOf } from '@/features/book/lib/__tests__/sync-chain-fixtures'

function mountCard(row: ChainCardRow, view: ChainViewMode = 'modify', frame?: ChainFrame, busy?: boolean) {
  return mount(SyncChainCard, { props: { row, view, frame, busy } })
}

const absMatched = () => chainOf({ abs: chainAbs({}, absLive()) })

describe('SyncChainCard', () => {
  it('frames a file of the book with its kind, file name, file summary and progress', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'ebook'))

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-border', 'bg-card']))
    expect(wrapper.text()).toContain('Ebook')
    expect(wrapper.get('[data-testid="sync-chain-title"]').text()).toBe('Book')
    expect(wrapper.text()).toContain('EPUB e-book · 1 kB')
    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('41% read')
    expect(wrapper.getComponent(EditionCover).props()).toMatchObject({ bookId: 7, medium: 'ebook', version: 'v7' })
  })

  it('counts the files of a split audiobook', () => {
    const chain = chainOf({ audiobook: chainEdition({ formatName: 'MP3 audio', fileCount: 12, sizeBytes: 1024 }) })
    expect(mountCard(cardRow(chain, 'audiobook')).text()).toContain('MP3 audio · 12 files · 1 kB')
  })

  it('keeps the card chrome in compact and drops only the actions', () => {
    const wrapper = mountCard(cardRow(absMatched(), 'abs'), 'compact', 'spine')

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-border', 'bg-card', 'px-2', 'py-1.5']))
    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-progress"]').exists()).toBe(true)
  })

  describe('number tween', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('animates its bar and counts its number through the values in between', async () => {
      const row = cardRow(chainOf(), 'audiobook')
      const wrapper = mountCard(row)
      const bar = wrapper.get('[data-testid="sync-chain-progress"] .h-full')
      const number = () => wrapper.get('[data-testid="sync-chain-progress"] span').text()
      expect(bar.classes()).toEqual(expect.arrayContaining(['transition-[width]', 'duration-700']))
      expect(number()).toBe('63%')

      await wrapper.setProps({ row: { ...row, progress: 100 } })
      expect(bar.attributes('style')).toContain('width: 100%')
      expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('100% listened')

      vi.advanceTimersByTime(100)
      await nextTick()
      const between = Number.parseInt(number(), 10)
      expect(between).toBeGreaterThan(63)
      expect(between).toBeLessThan(100)

      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(number()).toBe('100%')
    })

    it('counts up from zero when a value first appears without a pending check', async () => {
      const none = { ...cardRow(chainOf(), 'audiobook'), progress: null }
      const wrapper = mountCard(none)
      expect(wrapper.find('[data-testid="sync-chain-progress"]').exists()).toBe(false)

      await wrapper.setProps({ row: { ...none, progress: 60 } })

      const number = () => wrapper.get('[data-testid="sync-chain-progress"] span').text()
      expect(number()).toBe('0%')
      const bar = wrapper.get('[data-testid="sync-chain-progress"] .h-full')
      expect(bar.attributes('style')).toContain('width: 0%')
      await nextTick()
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(bar.attributes('style')).toContain('width: 60%')
      expect(number()).toBe('60%')
    })

    it('does not animate across a book switch', async () => {
      const row = cardRow(chainOf(), 'audiobook')
      const wrapper = mountCard(row)

      await wrapper.setProps({ row: { ...row, id: 'card:other', progress: 10 } })
      vi.advanceTimersByTime(100)
      await nextTick()

      expect(wrapper.get('[data-testid="sync-chain-progress"] span').text()).toBe('10%')
    })

    it('keeps the number steady when the value drops out and returns', async () => {
      const row = cardRow(chainOf(), 'audiobook')
      const wrapper = mountCard(row)

      await wrapper.setProps({ row: { ...row, progress: null } })
      await wrapper.setProps({ row: { ...row, progress: 63 } })

      expect(wrapper.get('[data-testid="sync-chain-progress"] span').text()).toBe('63%')
    })

    it('shows the first value at once when progress arrives after the live check', async () => {
      const pending = cardRow(chainOf({ abs: { ...chainAbs({}, null), checking: true } }), 'abs')
      const wrapper = mountCard(pending)
      expect(wrapper.find('[data-testid="sync-chain-progress-pending"]').exists()).toBe(true)

      await wrapper.setProps({ row: cardRow(chainOf({ abs: chainAbs({}, absLive()) }), 'abs') })

      expect(wrapper.get('[data-testid="sync-chain-progress"] span').text()).toBe('52%')
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.get('[data-testid="sync-chain-progress"] span').text()).toBe('52%')
    })
  })

  it('tints audiobook progress with the audiobook token', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'))

    expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('63% listened')
    expect(wrapper.get('[data-testid="sync-chain-progress"]').html()).toContain('bg-[var(--pill-media-audiobook)]')
  })

  it('offers Change on the Audiobookshelf match and emits it with the card', async () => {
    const wrapper = mountCard(cardRow(absMatched(), 'abs'))

    await wrapper.get('[data-testid="sync-chain-change"]').trigger('click')

    expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:abs'])
  })

  it('ignores Change and Confirm while the panel is busy', async () => {
    const change = mountCard(cardRow(absMatched(), 'abs'), 'modify', undefined, true)
    expect(change.get('[data-testid="sync-chain-change"]').attributes('aria-disabled')).toBe('true')
    await change.get('[data-testid="sync-chain-change"]').trigger('click')
    expect(change.emitted('action')).toBeUndefined()

    const review = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'needs_review' }) })
    expect(mountCard(cardRow(review, 'abs'), 'modify', undefined, true).get('[data-action="confirmAbs"]').attributes('disabled')).toBeDefined()
  })

  it('moves focus to its Change button on request', () => {
    const wrapper = mount(SyncChainCard, {
      props: { row: cardRow(absMatched(), 'abs'), view: 'modify' },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-change"]').element)
    wrapper.unmount()
  })

  it('keeps focus inside a compact card, which has no Change button, on request', () => {
    const wrapper = mount(SyncChainCard, {
      props: { row: cardRow(chainOf(), 'audiobook'), view: 'compact' },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    expect(wrapper.element.contains(document.activeElement)).toBe(true)
    wrapper.unmount()
  })

  it('opens the Audiobookshelf item in a new tab and falls back to the library icon', async () => {
    const chain = chainOf({ abs: chainAbs({}, absLive()) })
    const wrapper = mountCard(cardRow(chain, 'abs'))

    expect(wrapper.text()).toContain('Audiobookshelf')
    expect(wrapper.find('[data-testid="sync-chain-external"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Fiction library')
    const link = wrapper.get('[data-testid="sync-chain-title"] a')
    expect(link.attributes('href')).toBe('https://abs.example/item/li_1')
    expect(link.attributes('target')).toBe('_blank')
    expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('52% listened')

    await wrapper.get('[data-testid="sync-chain-abs-cover"] img').trigger('error')
    expect(wrapper.find('[data-testid="sync-chain-abs-cover-fallback"]').exists()).toBe(true)
  })

  it('shows a shimmer while the live check runs', () => {
    const chain = chainOf({ abs: { ...chainAbs({}, null), checking: true } })

    expect(mountCard(cardRow(chain, 'abs')).find('[data-testid="sync-chain-progress-pending"]').exists()).toBe(true)
  })

  describe('dashed', () => {
    const paused = (pausedReason: 'excluded' | 'needs_review') => chainOf({ abs: chainAbs({ syncing: false, pausedReason }) })

    it('looks paused: dashed, transparent, a chip in the caption row', () => {
      const wrapper = mountCard(cardRow(paused('excluded'), 'abs'), 'modify', 'spine')

      const card = wrapper.get('[data-testid="sync-chain-card"]')
      expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border-dashed', 'border-border', 'bg-transparent']))
      expect(card.attributes('data-linked')).toBe('false')
      expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('Paused')
    })

    it('confirms an Audiobookshelf match that needs review', async () => {
      const wrapper = mountCard(cardRow(paused('needs_review'), 'abs'))

      expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('Needs review')
      expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(true)
      await wrapper.get('[data-action="confirmAbs"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['confirmAbs', 'card:abs'])
    })

    it('keeps a file of the book solid', () => {
      const wrapper = mountCard(cardRow(chainOf(), 'audiobook'))
      expect(wrapper.get('[data-testid="sync-chain-card"]').attributes('data-linked')).toBe('true')
      expect(wrapper.find('[data-testid="sync-chain-chip"]').exists()).toBe(false)
    })
  })

  it('names an untitled book', () => {
    const chain = chainOf({ audiobook: chainEdition({ title: null }) })

    expect(mountCard(cardRow(chain, 'audiobook')).get('[data-testid="sync-chain-title"]').text()).toBe('Untitled')
  })

  it('drops its chrome inside the audio group but keeps padding and focusChange', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'), 'modify', 'group')

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['px-2', 'py-1.5']))
    for (const dropped of ['rounded-xl', 'border', 'border-border', 'border-dashed', 'bg-card']) expect(card.classes()).not.toContain(dropped)
    expect(typeof (wrapper.vm as unknown as { focusChange: () => void }).focusChange).toBe('function')
  })
})
