import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import type { AbsSyncBusy } from '@/features/book/composables/useAudiobookshelfSyncActions'
import SyncChainAbsDetails from '../SyncChainAbsDetails.vue'
import { absLive, chainAbs, chainOf, connectorRow } from '@/features/book/lib/__tests__/sync-chain-fixtures'

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } }

function mountDetails(
  live: AudiobookshelfBookSyncLive,
  direction: 'two_way' | 'from_abs' | 'to_abs' = 'two_way',
  busy: AbsSyncBusy | null = null,
  actionError: string | null = null,
) {
  const row = connectorRow(chainOf({ abs: chainAbs({ direction }, live) }), 'audiobook-abs')
  return mount(SyncChainAbsDetails, { props: { row, live, busy, actionError }, global: { stubs } })
}

const hint = (wrapper: ReturnType<typeof mountDetails>) => wrapper.find('[data-testid="sync-chain-abs-hint"]')
const actionIds = (wrapper: ReturnType<typeof mountDetails>) =>
  wrapper.findAll('[data-testid="sync-chain-action"]').map((button) => button.attributes('data-action'))

describe('SyncChainAbsDetails', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says nothing and offers nothing while in sync both ways', () => {
    const wrapper = mountDetails(absLive())

    expect(hint(wrapper).exists()).toBe(false)
    expect(actionIds(wrapper)).toEqual([])
    expect(wrapper.find('[data-testid="sync-chain-abs-settings"]').exists()).toBe(false)
  })

  it('names both positions and the reason when they diverged, with both fixes', async () => {
    const wrapper = mountDetails(
      absLive({
        status: 'diverged',
        progress: { percentage: 52.4, isFinished: false, lastUpdate: 1 },
        local: { percentage: 30, capturedAt: 'x' },
        divergedReason: 'push_off',
      }),
    )

    expect(hint(wrapper).text()).toBe('Audiobookshelf 52%, BookOrbit 30%. Sending is off.')
    expect(actionIds(wrapper)).toEqual(['absPush', 'absPull'])
    await wrapper.get('[data-action="absPull"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['absPull'])
  })

  it('disables Send to ABS and Use ABS while the panel is busy', async () => {
    const live = absLive({
      status: 'diverged',
      progress: { percentage: 52.4, isFinished: false, lastUpdate: 1 },
      local: { percentage: 30, capturedAt: 'x' },
      divergedReason: 'push_off',
    })
    const row = connectorRow(chainOf({ abs: chainAbs({ direction: 'two_way' }, live) }), 'audiobook-abs')
    const wrapper = mount(SyncChainAbsDetails, { props: { row, live, panelBusy: true }, global: { stubs } })

    for (const id of ['absPush', 'absPull']) {
      expect(wrapper.get(`[data-action="${id}"]`).attributes('aria-disabled')).toBe('true')
      expect(wrapper.get(`[data-action="${id}"]`).attributes('disabled')).toBeUndefined()
      await wrapper.get(`[data-action="${id}"]`).trigger('click')
    }
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it('says when a newer Audiobookshelf position landed and offers to use it now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    const lastUpdate = new Date('2026-10-10T11:55:00Z').getTime()
    const wrapper = mountDetails(absLive({ status: 'receiving', progress: { percentage: 60, isFinished: false, lastUpdate } }))

    expect(hint(wrapper).text()).toBe('Updated 5 minutes ago, picked up on the next sync.')
    expect(wrapper.get('[data-action="absPull"]').text()).toBe('Use it now')
  })

  it('narrates a position on its way without an action', () => {
    const wrapper = mountDetails(absLive({ status: 'sending' }))

    expect(hint(wrapper).text()).toBe('Your newer position is on its way.')
    expect(actionIds(wrapper)).toEqual([])
  })

  it('leaves a one-way match to the connector explainer', () => {
    const wrapper = mountDetails(absLive(), 'from_abs')

    expect(wrapper.find('[data-testid="sync-chain-abs-hint"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-abs-settings"]').exists()).toBe(false)
  })

  it('spins the running action, holds the others, and shows a failed reconcile', () => {
    const wrapper = mountDetails(absLive({ status: 'diverged', divergedReason: null }), 'two_way', 'push', 'Sync is busy, try again in a moment.')

    expect(wrapper.get('[data-action="absPush"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-action="absPull"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('[data-testid="sync-chain-abs-error"]').text()).toBe('Sync is busy, try again in a moment.')
  })

  it('keeps Retry busy until the new live status arrives', () => {
    const wrapper = mountDetails(absLive({ status: 'unreachable', progress: null }), 'two_way', 'retry')

    expect(wrapper.get('[data-action="retryAbs"]').attributes('aria-busy')).toBe('true')
  })

  it('puts the Settings link on the hint line as "Change in settings", not among the buttons', () => {
    const live = absLive({ status: 'diverged' })
    const row = connectorRow(chainOf({ abs: chainAbs({ direction: 'from_abs' }, live) }), 'audiobook-abs')
    const wrapper = mount(SyncChainAbsDetails, { props: { row, live }, global: { stubs } })

    const hint = wrapper.get('[data-testid="sync-chain-abs-hint"]')
    const link = hint.get('[data-testid="sync-chain-abs-settings"]')
    expect(link.text()).toBe('Change in settings')
    expect(wrapper.findAll('[data-action]').map((button) => button.attributes('data-action'))).toEqual(['absPush', 'absPull'])
    expect(wrapper.find('.flex-wrap [data-testid="sync-chain-abs-settings"]').exists()).toBe(false)
  })
})
