import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ChainFrame, ChainGhostRow, ChainViewMode } from '@/features/book/lib/sync-chain'
import SyncChainGhost from '../SyncChainGhost.vue'
import { chainAbs, chainOf, ghostRow } from '@/features/book/lib/__tests__/sync-chain-fixtures'

const stubs = { RouterLink: { props: ['to'], template: '<a data-testid="router-link" :href="JSON.stringify(to)"><slot /></a>' } }

function mountGhost(row: ChainGhostRow, view: ChainViewMode = 'modify', busy = false, frame?: ChainFrame) {
  return mount(SyncChainGhost, { props: { row, view, busy, frame }, global: { stubs } })
}

const NO_MATCH = 'No match in your libraries'

const createGhost = () => ghostRow(chainOf({ abs: { configured: true, link: null, live: null, checking: false } }), 'abs')

describe('SyncChainGhost', () => {
  it('draws a dashed one-line slot with its label and note', () => {
    const wrapper = mountGhost(createGhost())

    const root = wrapper.get('[data-testid="sync-chain-ghost"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['border-dashed', 'rounded-xl']))
    expect(wrapper.get('[data-testid="sync-chain-placeholder-label"]').text()).toBe('Audiobookshelf')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe(NO_MATCH)
  })

  it('offers Match when the audiobook has no Audiobookshelf item', async () => {
    const chain = chainOf({ abs: { configured: true, link: null, live: null, checking: false } })
    const wrapper = mountGhost(ghostRow(chain, 'abs'))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('No match in your libraries')
    await wrapper.get('[data-action="change"]').trigger('click')
    expect(wrapper.text()).toContain('Match')
    expect(wrapper.emitted('action')?.[0]).toEqual(['change', 'card:abs'])
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
    const wrapper = mountGhost(createGhost(), 'compact')

    const line = wrapper.get('[data-testid="sync-chain-placeholder-label"]').element.parentElement!
    expect(Array.from(line.children).map((child) => child.getAttribute('data-testid'))).toEqual([
      'sync-chain-placeholder-label',
      'sync-chain-placeholder-note',
    ])
  })

  it('points its compact action at a note that exists', () => {
    const wrapper = mountGhost(createGhost(), 'compact')

    const describedBy = wrapper.get('[data-action="change"]').attributes('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').attributes('id')).toBe(describedBy)
  })

  it('disables its action while the panel is busy', () => {
    const wrapper = mountGhost(createGhost(), 'modify', true)

    expect(wrapper.get('[data-action="change"]').attributes('disabled')).toBeDefined()
  })

  it('moves focus to its action on request', () => {
    const wrapper = mount(SyncChainGhost, {
      props: { row: createGhost(), view: 'modify' },
      global: { stubs },
      attachTo: document.body,
    })

    ;(wrapper.vm as unknown as { focusChange: () => void }).focusChange()

    expect(document.activeElement).toBe(wrapper.get('[data-action="change"]').element)
    wrapper.unmount()
  })

  it('keeps its dashed shell on one line with its action as a text link in compact', () => {
    const wrapper = mountGhost(createGhost(), 'compact')

    const root = wrapper.get('[data-testid="sync-chain-ghost"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border-dashed']))
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').classes()).toContain('truncate')
    const action = wrapper.get('button')
    expect(action.text()).toBe('Match')
    expect(action.classes()).toEqual(expect.arrayContaining(['text-info', '-my-1']))
    expect(root.text()).toContain(NO_MATCH)
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
