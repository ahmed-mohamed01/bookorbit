import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ChainCardRow, ChainViewMode } from '@/features/book/lib/sync-chain'
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

function mountCard(row: ChainCardRow, view: ChainViewMode = 'modify') {
  return mount(SyncChainCard, { props: { row, view }, global: { stubs } })
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

  it('drops the chrome and the actions in compact', () => {
    const wrapper = mountCard(cardRow(chainOf(), 'audiobook'), 'compact')

    const card = wrapper.get('[data-testid="sync-chain-card"]')
    expect(card.classes()).not.toContain('bg-card')
    expect(card.classes()).not.toContain('rounded-xl')
    expect(wrapper.find('[data-testid="sync-chain-change"]').exists()).toBe(false)
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
})
