import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChainCardRow, ChainFrame, ChainViewMode } from '@/features/book/lib/sync-chain'
import EditionCover from '../EditionCover.vue'
import ReadAlongStepper from '../ReadAlongStepper.vue'
import SyncChainCard from '../SyncChainCard.vue'
import {
  absLive,
  cardRow,
  chainAbs,
  chainBook,
  chainMember,
  chainOf,
  chainReadAlong,
  chainSide,
} from '@/features/book/lib/__tests__/sync-chain-fixtures'

const stubs = { RouterLink: { props: ['to'], template: '<a data-testid="router-link" :href="JSON.stringify(to)"><slot /></a>' } }

function mountCard(row: ChainCardRow, view: ChainViewMode = 'modify', frame?: ChainFrame, busy?: boolean) {
  return mount(SyncChainCard, { props: { row, view, frame, busy }, global: { stubs } })
}

const withReadAlong = (overrides = {}) =>
  chainOf({
    readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    ...overrides,
  })

describe('SyncChainCard', () => {
  it('frames this book in Modify with its kind, This book and its progress', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'ebook'))

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'bg-card', 'border-primary']))
    expect(wrapper.text()).toContain('Ebook')
    expect(wrapper.find('[data-testid="sync-chain-this-book"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="router-link"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('41% read')
    expect(wrapper.getComponent(EditionCover).props()).toMatchObject({ bookId: 1, medium: 'ebook', version: 'v1' })
  })

  it('keeps the card chrome in compact and drops only the actions', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'), 'compact')

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-border', 'bg-card', 'px-2', 'py-1.5']))
    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-progress"]').exists()).toBe(true)

    const thisBook = mountCard(cardRow(chainOf(), 'ebook'), 'compact').get('[data-testid="sync-chain-card"]')
    expect(thisBook.classes()).toContain('border-primary')
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

      await wrapper.setProps({ row: { ...row, routeBookId: 99, progress: 10 } })
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

  it('links another book to its page and tints its progress with the audiobook token', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'))

    expect(wrapper.get('[data-testid="router-link"]').attributes('href')).toContain('"bookId":2')
    expect(wrapper.get('[data-testid="sync-chain-progress"]').attributes('aria-label')).toBe('63% listened')
    expect(wrapper.get('[data-testid="sync-chain-progress"]').html()).toContain('bg-[var(--pill-media-audiobook)]')
    expect(wrapper.get('[data-testid="sync-chain-card"]').classes()).toContain('border-border')
  })

  it('offers Change on the other edition and emits it with the card', async () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'))

    await wrapper.get('[data-testid="sync-chain-change"]').trigger('click')

    expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:audiobook'])
  })

  it('blocks Change while a read-along exists, keeps it focusable and says why in plain sight', async () => {
    const wrapper = mountCard(cardRow(withReadAlong(), 'audiobook'))

    const change = wrapper.get('[data-testid="sync-chain-change"]')
    expect(change.attributes('disabled')).toBeUndefined()
    expect(change.attributes('aria-disabled')).toBe('true')
    const hint = wrapper.get('[data-testid="sync-chain-change-hint"]')
    expect(hint.text()).toBe('Rebuild or detach the read-along first')
    expect(hint.classes()).not.toContain('sr-only')
    expect(change.attributes('aria-describedby')).toBe(hint.attributes('id'))

    await change.trigger('click')
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it('ignores Change, Rebuild, Confirm and the job actions while the panel is busy', async () => {
    const change = mountCard(cardRow(chainOf(), 'audiobook'), 'modify', undefined, true)
    expect(change.get('[data-testid="sync-chain-change"]').attributes('aria-disabled')).toBe('true')
    await change.get('[data-testid="sync-chain-change"]').trigger('click')
    expect(change.emitted('action')).toBeUndefined()

    const rebuild = mountCard(cardRow(withReadAlong(), 'readAlong'), 'modify', undefined, true)
    expect(rebuild.get('[data-action="rebuildReadAlong"]').attributes('disabled')).toBeDefined()

    const review = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'needs_review' }) })
    expect(mountCard(cardRow(review, 'abs'), 'modify', undefined, true).get('[data-action="confirmAbs"]').attributes('disabled')).toBeDefined()

    const building = withReadAlong({
      readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS' }),
    })
    expect(
      mountCard(cardRow(building, 'readAlong'), 'modify', undefined, true).get('[data-action="cancelReadAlong"]').attributes('disabled'),
    ).toBeDefined()

    const failed = withReadAlong({ readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'failed', error: 'boom' }) })
    const retry = mountCard(cardRow(failed, 'readAlong'), 'modify', undefined, true).find(
      '[data-testid="sync-chain-card-job"] [data-testid="sync-chain-action"]:not([data-action="cancelReadAlong"])',
    )
    expect(retry.exists()).toBe(true)
    expect(retry.attributes('disabled')).toBeDefined()
  })

  it('words the Change-blocked hint from the row', () => {
    const blocked = cardRow(withReadAlong(), 'audiobook')
    const hinted = mountCard({ ...blocked, changeHint: { key: 'book.detail.editionLink.chain.short.abs' } })
    expect(hinted.get('[data-testid="sync-chain-change-hint"]').text()).toBe('ABS')
  })

  it('shows no hint when Change is offered', () => {
    expect(mountCard(cardRow(chainOf(), 'audiobook')).find('[data-testid="sync-chain-change-hint"]').exists()).toBe(false)
  })

  it('moves focus to its Change button on request', () => {
    const wrapper = mount(SyncChainCard, {
      props: { row: cardRow(chainOf(), 'audiobook'), view: 'modify' },
      global: { stubs },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-change"]').element)
    wrapper.unmount()
  })

  it('keeps focus inside a compact card, which has no Change button, on request', () => {
    const wrapper = mount(SyncChainCard, {
      props: { row: cardRow(chainOf(), 'audiobook'), view: 'compact' },
      global: { stubs },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    expect(wrapper.element.contains(document.activeElement)).toBe(true)
    wrapper.unmount()
  })

  it('offers Rebuild on a ready read-along member', async () => {
    const wrapper = mountCard(cardRow(withReadAlong(), 'readAlong'))

    expect(wrapper.get('[data-action="rebuildReadAlong"]').text()).toBe('Rebuild')
    await wrapper.get('[data-action="rebuildReadAlong"]').trigger('click')

    expect(wrapper.emitted('action')?.[0]).toEqual(['rebuildReadAlong', 'card:readAlong'])
  })

  it('shows a read-along member being rebuilt with its stepper and cancel', async () => {
    const chain = withReadAlong({
      readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS' }),
    })
    const wrapper = mountCard(cardRow(chain, 'readAlong'))

    expect(wrapper.find('[data-testid="read-along-stepper"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="read-along-stage"]').map((stage) => stage.attributes('data-stage-state'))).toEqual([
      'done',
      'done',
      'current',
      'todo',
    ])
    await wrapper.get('[data-action="cancelReadAlong"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['cancelReadAlong', 'card:readAlong'])
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
    const candidate = (overrides = {}) =>
      chainOf({
        linked: false,
        ebook: chainSide({ book: chainBook(1, 'Ebook'), isThisBook: true }),
        audiobook: chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'auto', score: 100 } }),
        ...overrides,
      })

    it('looks unlinked: dashed, transparent, a dimmed cover and a chip in the caption row', () => {
      const wrapper = mountCard(cardRow(candidate(), 'audiobook'))

      const card = wrapper.get('[data-testid="sync-chain-card"]')
      expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border-dashed', 'border-border', 'bg-transparent']))
      expect(card.classes()).not.toContain('bg-card')
      expect(card.attributes('data-linked')).toBe('false')
      expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('100% match')
      expect(wrapper.getComponent(EditionCover).element.closest('.opacity-70')).not.toBeNull()
    })

    it('has no Link button, only Change, which emits the card id', async () => {
      const wrapper = mountCard(cardRow(candidate(), 'audiobook'))

      expect(wrapper.text()).not.toContain('Link')
      expect(wrapper.find('[data-action="linkPair"]').exists()).toBe(false)
      await wrapper.get('[data-testid="sync-chain-change"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:audiobook'])
    })

    it('words the chip for a picked edition, a read-along pair, a detached read-along and a paused match', () => {
      const picked = candidate({ audiobook: chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'manual' } }) })
      expect(mountCard(cardRow(picked, 'audiobook')).get('[data-testid="sync-chain-chip"]').text()).toBe('Selected')

      const pair = candidate({ audiobook: chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'pair' } }) })
      expect(mountCard(cardRow(pair, 'audiobook')).get('[data-testid="sync-chain-chip"]').text()).toBe('Generated from Audiobook')
      expect(mountCard(cardRow(pair, 'audiobook')).find('[data-testid="sync-chain-change"]').exists()).toBe(false)

      const detached = chainOf({ readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }) })
      expect(mountCard(cardRow(detached, 'readAlong')).get('[data-testid="sync-chain-chip"]').text()).toBe('Generated')

      const paused = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'excluded' }) })
      expect(mountCard(cardRow(paused, 'abs')).get('[data-testid="sync-chain-chip"]').text()).toBe('Paused')
    })

    it('confirms an Audiobookshelf match that needs review', async () => {
      const review = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'needs_review' }) })
      const wrapper = mountCard(cardRow(review, 'abs'))

      expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('Needs review')
      expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(true)
      await wrapper.get('[data-action="confirmAbs"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['confirmAbs', 'card:abs'])
    })

    it('keeps its dashed card and chip in compact, without Change', () => {
      const wrapper = mountCard(cardRow(candidate(), 'audiobook'), 'compact')

      const card = wrapper.get('[data-testid="sync-chain-card"]')
      expect(card.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-dashed', 'border-border', 'bg-transparent']))
      expect(wrapper.get('[data-testid="sync-chain-title"]').text()).toBe('Audiobook')
      expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('100% match')
      expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
    })

    it('keeps a linked card solid', () => {
      const row = cardRow(chainOf(), 'audiobook')
      expect(row.linked).toBe(true)
      const wrapper = mountCard(row)
      expect(wrapper.get('[data-testid="sync-chain-card"]').attributes('data-linked')).toBe('true')
      expect(wrapper.find('[data-testid="sync-chain-chip"]').exists()).toBe(false)
    })
  })

  it('names an untitled book', () => {
    const chain = chainOf({ audiobook: chainSide({ book: chainBook(2, null), isMember: true }) })

    expect(mountCard(cardRow(chain, 'audiobook')).get('[data-testid="sync-chain-title"]').text()).toBe('Untitled')
  })

  it('shows the read-along tile when the read-along page has no book to show', () => {
    const chain = chainOf({ thisBook: 'readAlong', linked: false, ebook: chainSide(), audiobook: chainSide() })

    expect(mountCard(cardRow(chain, 'readAlong')).find('[data-testid="sync-chain-read-along-tile"]').exists()).toBe(true)
  })

  it('marks the stepper failed for a read-along build that failed', () => {
    const chain = withReadAlong({ readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'failed', error: 'boom' }) })

    expect(mountCard(cardRow(chain, 'readAlong')).getComponent(ReadAlongStepper).props('failed')).toBe(true)
  })

  it('drops its chrome inside the audio group but keeps padding, data-this-book and focusChange', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'ebook'), 'modify', 'group')

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['px-2', 'py-1.5']))
    for (const dropped of ['rounded-xl', 'border', 'border-primary', 'border-border', 'border-dashed', 'bg-card'])
      expect(card.classes()).not.toContain(dropped)
    expect(card.attributes('data-this-book')).toBe('true')
    expect(typeof (wrapper.vm as unknown as { focusChange: () => void }).focusChange).toBe('function')
  })

  it('keeps a dashed candidate plain inside the group', () => {
    const chain = chainOf({ linked: false, audiobook: chainSide({ book: chainBook(2, 'A'), match: { source: 'manual' } }) })
    const card = mountCard(cardRow(chain, 'audiobook'), 'modify', 'group').get('[data-testid="sync-chain-card"]')

    expect(card.attributes('data-linked')).toBe('false')
    expect(card.classes()).not.toContain('border-dashed')
  })
})
