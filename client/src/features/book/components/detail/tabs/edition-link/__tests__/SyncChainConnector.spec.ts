import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import type { ChainConnectorRow, ChainViewMode } from '@/features/book/lib/sync-chain'
import SyncChainConnector from '../SyncChainConnector.vue'
import {
  absLive,
  chainAbs,
  chainAlignment,
  chainMember,
  chainOf,
  chainReadAlong,
  chainSide,
  chainBook,
  connectorRow,
} from '@/features/book/lib/__tests__/sync-chain-fixtures'
import { withMessages } from './with-messages'

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } }

function mountConnector(
  row: ChainConnectorRow,
  view: ChainViewMode = 'modify',
  props: { busy?: boolean; cancelling?: boolean; absLive?: AudiobookshelfBookSyncLive | null } = {},
) {
  return mount(SyncChainConnector, { props: { row, view, ...props }, global: { stubs } })
}

const pairRow = (alignment = chainAlignment()) => connectorRow(chainOf({ alignment }), 'ebook-audiobook')
const readAlongChain = (overrides = {}) =>
  chainOf({
    readAlong: chainReadAlong({ member: chainMember(3, 'Read-along'), status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    ...overrides,
  })

describe('SyncChainConnector', () => {
  it('labels an aligned pair with its editions, its pill and an on switch named for both', () => {
    const wrapper = mountConnector(pairRow())

    expect(wrapper.text()).toContain('Ebook ↔ Audiobook')
    const pill = wrapper.get('[data-testid="sync-chain-pill"]')
    expect(pill.text()).toBe('Linked · via Whisper')
    expect(pill.classes()).toEqual(expect.arrayContaining(['bg-success/15', 'text-success']))
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.attributes('aria-label')).toBe('Sync Ebook and Audiobook')
    expect(toggle.classes()).toContain('bg-success')
    expect(wrapper.find('[data-testid="position-sync-ticks"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="position-sync-indeterminate"]').exists()).toBe(false)
  })

  it.each([
    ['linking', chainAlignment({ running: true, builtAt: null }), 'Linking', 'bg-info/15'],
    ['rebuilding', chainAlignment({ running: true }), 'Rebuilding', 'bg-info/15'],
    ['alignmentFailed', chainAlignment({ status: 'failed', buildError: 'whisper died' }), 'Alignment failed', 'bg-destructive/15'],
    ['outOfDate', chainAlignment({ stale: true }), 'Out of date', 'bg-warning/15'],
    ['cantAlign', chainAlignment({ status: 'unalignable' }), "Can't align", 'bg-muted'],
    ['alignmentBlocked', chainAlignment({ status: 'none', builtAt: null, buildBlocked: 'disabled' }), 'Not aligned', 'bg-muted'],
    ['notAligned', chainAlignment({ status: 'none', builtAt: null }), 'Not aligned', 'bg-warning/15'],
  ] as const)('shows the %s pill', (state, alignment, pill, pillClass) => {
    const wrapper = mountConnector(pairRow(alignment))

    expect(wrapper.get('[data-testid="sync-chain-connector"]').attributes('data-state')).toBe(state)
    expect(wrapper.get('[data-testid="sync-chain-pill"]').text()).toBe(pill)
    expect(wrapper.get('[data-testid="sync-chain-pill"]').classes()).toContain(pillClass)
  })

  it('draws the rail dashed for muted and failed states, solid otherwise', () => {
    expect(
      mountConnector(pairRow(chainAlignment({ status: 'failed' })))
        .get('[data-testid="sync-chain-node"]')
        .classes(),
    ).toContain('border-dashed')
    expect(mountConnector(pairRow()).get('[data-testid="sync-chain-node"]').classes()).toContain('border-solid')
  })

  it('shows the ticks and a named cancel only while aligning, and emits the cancel', async () => {
    const linking = mountConnector(pairRow(chainAlignment({ running: true, builtAt: null, samplesDone: 2, samplesTotal: 10 })))
    expect(linking.find('[data-testid="position-sync-ticks"]').exists()).toBe(true)
    const cancel = linking.get('[data-action="cancelLinking"]')
    expect(cancel.attributes('aria-label')).toBe('Cancel linking')
    await cancel.trigger('click')
    expect(linking.emitted('action')?.[0]).toEqual(['cancelLinking', 'connector:ebook-audiobook'])

    const rebuilding = mountConnector(pairRow(chainAlignment({ running: true })))
    expect(rebuilding.get('[data-action="cancelAlignment"]').attributes('aria-label')).toBe('Cancel alignment rebuild')
  })

  it('keeps Cancel linking clickable while the panel is busy linking, and locks it only while a cancel is in flight', () => {
    const row = pairRow(chainAlignment({ running: true, builtAt: null }))

    expect(mountConnector(row, 'modify', { busy: true }).get('[data-action="cancelLinking"]').attributes('disabled')).toBeUndefined()
    expect(mountConnector(row, 'modify', { busy: true }).get('[role="switch"]').attributes('disabled')).toBeDefined()
    expect(mountConnector(row, 'modify', { busy: true, cancelling: true }).get('[data-action="cancelLinking"]').attributes('disabled')).toBeDefined()
  })

  it('hides the switch for a failed alignment and shows the build error with Retry and Unlink', async () => {
    const wrapper = mountConnector(pairRow(chainAlignment({ status: 'failed', buildError: 'whisper died' })))

    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-detail"]').text()).toBe('whisper died')
    expect(wrapper.findAll('[data-testid="sync-chain-action"]').map((button) => button.attributes('data-action'))).toEqual([
      'retryAlignment',
      'unlinkPair',
    ])

    await wrapper.get('[data-action="unlinkPair"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['unlinkPair', 'connector:ebook-audiobook'])
  })

  it('tints the switch of an out-of-date map as a warning', () => {
    const wrapper = mountConnector(pairRow(chainAlignment({ stale: true })))

    expect(wrapper.get('[role="switch"]').classes()).toContain('bg-warning')
    expect(wrapper.get('[data-testid="sync-chain-note"]').text()).toContain('The audiobook file changed')
  })

  it('emits the connector key with the next switch value', async () => {
    const wrapper = mountConnector(pairRow())

    await wrapper.get('[role="switch"]').trigger('click')

    expect(wrapper.emitted('toggle')?.[0]).toEqual(['ebook-audiobook', false])
  })

  it('offers a detached read-along with its switch off', async () => {
    const chain = chainOf({
      thisBook: 'readAlong',
      ebook: chainSide({ book: chainBook(1, 'Ebook'), isMember: true }),
      readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    })
    const wrapper = mountConnector(connectorRow(chain, 'ebook-readAlong'))

    expect(wrapper.get('[data-testid="sync-chain-pill"]').text()).toBe('Not linked')
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['ebook-readAlong', true])
  })

  it('names a read-aloud issue between the read-along and the audiobook', () => {
    const chain = readAlongChain({
      thisBook: 'audiobook',
      readAloudIssue: {
        mode: 'auto',
        state: 'unavailable',
        unavailableReason: 'audio_changed',
        overlayFileId: null,
        audioDurationSeconds: null,
        overlayDurationSeconds: null,
        durationDifferenceSeconds: null,
        durationDifferenceRatio: null,
        koreaderDownloadAvailable: false,
        narrationMismatch: null,
        offsetsSource: null,
      },
    })
    const wrapper = mountConnector(connectorRow(chain, 'readAlong-audiobook'))

    expect(wrapper.get('[data-testid="sync-chain-pill"]').text()).toBe('Not syncing')
    expect(wrapper.get('[data-testid="sync-chain-note"]').text()).toBe('The audiobook files changed after this read-along was built.')
    expect(wrapper.find('[data-action="rebuildReadAlong"]').exists()).toBe(true)
  })

  it('renders the Audiobookshelf details instead of the note for an unreachable server', () => {
    const live = absLive({ status: 'unreachable', progress: null })
    const row = connectorRow(chainOf({ abs: chainAbs({}, live) }), 'audiobook-abs')
    const wrapper = mountConnector(row, 'modify', { absLive: live })

    expect(wrapper.get('[data-testid="sync-chain-pill"]').text()).toBe("Can't reach server")
    expect(wrapper.find('[data-testid="sync-chain-note"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-abs-hint"]').text()).toBe('Progress catches up when Audiobookshelf is back.')
    expect(wrapper.find('[data-action="retryAbs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sync-chain-abs-settings"]').exists()).toBe(true)
  })

  it('disables the switch while something is busy or without the edit permission', () => {
    expect(mountConnector(pairRow(), 'modify', { busy: true }).get('[role="switch"]').attributes('disabled')).toBeDefined()
    const readOnly = connectorRow(chainOf({ can: { editLink: false, generate: true, rebuild: true } }), 'ebook-audiobook')
    expect(mountConnector(readOnly).get('[role="switch"]').attributes('disabled')).toBeDefined()
  })

  describe('compact', () => {
    it('says nothing for a synced pair but keeps the state for screen readers', () => {
      const wrapper = mountConnector(pairRow(), 'compact')

      expect(wrapper.find('[data-testid="sync-chain-mini-text"]').exists()).toBe(false)
      expect(wrapper.find('[role="switch"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('Linked · via Whisper')
    })

    it('names a problem in its tone with its one action', async () => {
      const wrapper = mountConnector(pairRow(chainAlignment({ stale: true })), 'compact')

      const text = wrapper.get('[data-testid="sync-chain-mini-text"]')
      expect(text.text()).toBe('Out of date')
      expect(text.classes()).toContain('text-warning')
      await wrapper.get('[data-action="rebuildAlignment"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['rebuildAlignment', 'connector:ebook-audiobook'])
    })

    it('lets a long mini text shrink and truncate instead of overflowing the popover', () => {
      const wrapper = mountConnector(pairRow(chainAlignment({ stale: true })), 'compact')

      expect(wrapper.get('[data-testid="sync-chain-mini-text"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    })

    it('reads the mini text from the catalog', async () => {
      await withMessages({ book: { detail: { editionLink: { chain: { mini: { linking: 'Mapping…' } } } } } }, () => {
        const wrapper = mountConnector(pairRow(chainAlignment({ running: true, builtAt: null })), 'compact')

        expect(wrapper.get('[data-testid="sync-chain-mini-text"]').text()).toBe('Mapping…')
      })
    })
  })
})
