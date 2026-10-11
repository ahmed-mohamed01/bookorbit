import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ChainFrame, ChainGhostRow, ChainViewMode, SyncChainSnapshot } from '@/features/book/lib/sync-chain'
import SyncChainGhost from '../SyncChainGhost.vue'
import { chainAbs, chainAlignment, chainBook, chainOf, chainReadAlong, chainSide, ghostRow } from '@/features/book/lib/__tests__/sync-chain-fixtures'

const stubs = { RouterLink: { props: ['to'], template: '<a data-testid="router-link" :href="JSON.stringify(to)"><slot /></a>' } }

function mountGhost(row: ChainGhostRow, view: ChainViewMode = 'modify', busy = false, frame?: ChainFrame) {
  return mount(SyncChainGhost, { props: { row, view, busy, frame }, global: { stubs } })
}

const ebookOnly = (overrides: Partial<SyncChainSnapshot> = {}) =>
  chainOf({
    linked: false,
    ebook: chainSide({ book: chainBook(1, 'Ebook'), isThisBook: true }),
    audiobook: chainSide(),
    alignment: chainAlignment({ status: 'none', builtAt: null }),
    ...overrides,
  })

describe('SyncChainGhost', () => {
  it('draws a dashed one-line slot with its label and note', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'))

    const root = wrapper.get('[data-testid="sync-chain-ghost"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['border-dashed', 'rounded-xl']))
    expect(wrapper.get('[data-testid="sync-chain-placeholder-label"]').text()).toBe('Audiobook')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('No matching audiobook found yet')
  })

  it('offers Search on a missing ebook or audiobook and emits it with the slot id', async () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'))

    const search = wrapper.get('[data-action="change"]')
    expect(search.text()).toBe('Search')
    await search.trigger('click')

    expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:audiobook'])
  })

  it('has no action without the edit permission', () => {
    const chain = ebookOnly({ can: { editLink: false, generate: true, rebuild: true } })

    expect(mountGhost(ghostRow(chain, 'audiobook')).find('[data-testid="sync-chain-action"]').exists()).toBe(false)
  })

  it('offers Match when the audiobook has no Audiobookshelf item', async () => {
    const chain = chainOf({ abs: { configured: true, link: null, live: null, checking: false } })
    const wrapper = mountGhost(ghostRow(chain, 'abs'))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('No match in your libraries')
    await wrapper.get('[data-action="change"]').trigger('click')
    expect(wrapper.text()).toContain('Match')
    expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:abs'])
  })

  it('waits for the audiobook before Audiobookshelf can match, with no action', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly({ abs: chainAbs() }), 'abs'))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('Pick an audiobook first')
    expect(wrapper.find('[data-testid="sync-chain-action"]').exists()).toBe(false)
  })

  it('points to Settings when position sync is off, with no action', () => {
    const chain = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'position_sync_off' }) })
    const wrapper = mountGhost(ghostRow(chain, 'abs'))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toContain('Position sync is off in Settings')
    expect(wrapper.get('[data-testid="sync-chain-ghost-settings"]').attributes('href')).toContain('settings-audiobookshelf')
    expect(wrapper.find('[data-testid="sync-chain-action"]').exists()).toBe(false)
  })

  it('keeps the Settings link reachable in compact when position sync is off', () => {
    const chain = chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'position_sync_off' }) })
    const wrapper = mountGhost(ghostRow(chain, 'abs'), 'compact')

    expect(wrapper.get('[data-testid="sync-chain-ghost-settings"]').attributes('href')).toContain('settings-audiobookshelf')
  })

  it('renders no empty note link holder in compact when there is no Settings link', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'), 'compact')

    const line = wrapper.get('[data-testid="sync-chain-placeholder-label"]').element.parentElement!
    expect(Array.from(line.children).map((child) => child.getAttribute('data-testid'))).toEqual([
      'sync-chain-placeholder-label',
      'sync-chain-placeholder-note',
    ])
  })

  it('points its compact action at a note that exists', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'), 'compact')

    const describedBy = wrapper.get('[data-action="change"]').attributes('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').attributes('id')).toBe(describedBy)
  })

  it('says an out-of-reach read-along was added somewhere the reader cannot open', () => {
    const chain = chainOf({ readAlong: chainReadAlong({ status: 'ready' }) })
    const wrapper = mountGhost(ghostRow(chain, 'readAlong'))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe("Added to a library you can't open.")
    expect(wrapper.find('[data-testid="sync-chain-action"]').exists()).toBe(false)
  })

  it('disables its action while the panel is busy', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'), 'modify', true)

    expect(wrapper.get('[data-action="change"]').attributes('disabled')).toBeDefined()
  })

  it('moves focus to its action on request', () => {
    const wrapper = mount(SyncChainGhost, {
      props: { row: ghostRow(ebookOnly(), 'audiobook'), view: 'modify' },
      global: { stubs },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(document.activeElement).toBe(wrapper.get('[data-action="change"]').element)
    wrapper.unmount()
  })

  it('keeps its dashed shell on one line with its action as a text link in compact', () => {
    const wrapper = mountGhost(ghostRow(ebookOnly(), 'audiobook'), 'compact')

    const root = wrapper.get('[data-testid="sync-chain-ghost"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border-dashed']))
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').classes()).toContain('truncate')
    const action = wrapper.get('button')
    expect(action.text()).toBe('Search')
    expect(action.classes()).toEqual(expect.arrayContaining(['text-info', '-my-1']))
    expect(root.text()).toContain('No matching audiobook found yet')
  })

  it('is a plain row without a dashed outline inside the audio group, keeping its note and action', () => {
    const chain = chainOf({ abs: { configured: true, link: null, live: null, checking: false } })
    const wrapper = mountGhost(ghostRow(chain, 'abs'), 'modify', false, 'group')

    const root = wrapper.get('[data-testid="sync-chain-ghost"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['px-2', 'py-1.5']))
    for (const dropped of ['rounded-xl', 'border', 'border-dashed']) expect(root.classes()).not.toContain(dropped)
    expect(wrapper.get('[data-action="change"]').text()).toBe('Match')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-label"]').text()).toBe('Audiobookshelf')
  })
})
