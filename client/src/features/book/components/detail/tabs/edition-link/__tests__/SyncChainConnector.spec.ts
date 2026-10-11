import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
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
  it('labels an aligned pair with its editions, the Whisper qualifier inline and an on switch named for both', async () => {
    const wrapper = mountConnector(pairRow())

    const label = wrapper.get('[data-testid="sync-chain-label"]')
    expect(label.text()).toContain('Ebook')
    expect(label.text()).toContain('Audiobook')
    expect(label.get('[data-testid="sync-chain-arrow"]').attributes('aria-label')).toBe('syncs both ways')
    expect(wrapper.find('[data-testid="sync-chain-pill"]').exists()).toBe(false)
    const qualifier = wrapper.get('[data-testid="sync-chain-qualifier"]')
    expect(qualifier.text()).toContain('Whisper')
    expect(qualifier.classes()).toEqual(expect.arrayContaining(['bg-success/15', 'text-success']))
    const state = wrapper.get('[data-testid="sync-chain-state"]')
    expect(state.text()).toBe('Linked · via Whisper')
    expect(state.classes()).toContain('sr-only')
    const toggle = wrapper.get('[data-testid="sync-chain-rail"] [role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.attributes('aria-label')).toBe('Sync Ebook and Audiobook')
    expect(toggle.classes()).toContain('bg-success')
    expect(toggle.get('[data-testid="sync-chain-rail-thumb"]').classes()).toContain('text-success')
    expect(wrapper.find('[data-testid="sync-chain-node"]').exists()).toBe(false)
    const explain = wrapper.get('[data-testid="sync-chain-explain-toggle"]')
    expect(explain.attributes('aria-expanded')).toBe('false')
    expect(explain.attributes('aria-controls')).toBeUndefined()
    expect(wrapper.find('[data-testid="sync-chain-explainer"]').exists()).toBe(false)
    await explain.trigger('click')
    expect(explain.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="sync-chain-explainer"]').attributes('id')).toBe(explain.attributes('aria-controls'))
    expect(wrapper.get('[data-testid="sync-chain-explainer"]').text()).toContain('Two-way. Whisper maps')
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

  it('qualifies a linked read-along row as direct and keeps the state for screen readers', () => {
    const wrapper = mountConnector(connectorRow(readAlongChain(), 'readAlong-audiobook'))

    expect(wrapper.find('[data-testid="sync-chain-pill"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').text()).toBe('direct')
    expect(wrapper.get('[data-testid="sync-chain-state"]').text()).toBe('Linked')
  })

  it('qualifies a one-way Audiobookshelf link inline instead of a pill', async () => {
    const wrapper = mountConnector(connectorRow(chainOf({ abs: chainAbs({ direction: 'from_abs' }) }), 'audiobook-abs'))

    expect(wrapper.find('[data-testid="sync-chain-pill"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-arrow"]').attributes('data-arrow')).toBe('left')
    expect(wrapper.get('[data-testid="sync-chain-arrow"]').attributes('aria-label')).toBe('receives from')
    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').text()).toContain('one way')
    expect(wrapper.get('[data-testid="sync-chain-state"]').text()).toBe('Linked · one way')
    expect(wrapper.find('[data-testid="sync-chain-abs-hint"]').exists()).toBe(false)
    await wrapper.get('[data-testid="sync-chain-explain-toggle"]').trigger('click')
    const explainer = wrapper.get('[data-testid="sync-chain-explainer"]')
    expect(explainer.text()).toContain('One-way. Listening progress comes from your Audiobookshelf server')
    expect(explainer.find('[data-testid="sync-chain-explainer-settings"]').exists()).toBe(true)
  })

  it('draws the rail dashed for muted and failed states, solid otherwise', () => {
    const failed = mountConnector(pairRow(chainAlignment({ status: 'failed' })))
    expect(failed.get('[data-testid="sync-chain-rail-line"]').classes()).toContain('border-dashed')
    expect(failed.get('[data-testid="sync-chain-node"]').classes()).toContain('border-dashed')
    expect(mountConnector(pairRow()).get('[data-testid="sync-chain-rail-line"]').classes()).toContain('border-solid')
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
    expect(mountConnector(row, 'modify', { busy: true }).get('[role="switch"]').attributes('aria-disabled')).toBe('true')
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
    expect(wrapper.find('[data-testid="sync-chain-explain-toggle"]').exists()).toBe(false)
  })

  it('emits the connector key with the next switch value', async () => {
    const wrapper = mountConnector(pairRow())

    await wrapper.get('[role="switch"]').trigger('click')

    expect(wrapper.emitted('toggle')?.[0]).toEqual(['ebook-audiobook', false])
  })

  it('offers a detached read-along with its switch off and a muted qualifier instead of a pill', async () => {
    const chain = chainOf({ readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 3, title: 'Read-along' } }) })
    const wrapper = mountConnector(connectorRow(chain, 'readAlong-audiobook'))

    expect(wrapper.find('[data-testid="sync-chain-pill"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-label"]').text()).toContain('Read-along')
    expect(wrapper.get('[data-testid="sync-chain-arrow"]').attributes('data-arrow')).toBe('both')
    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').text()).toContain('not linked')
    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').classes()).toContain('bg-muted')
    expect(wrapper.find('[data-testid="sync-chain-explain-toggle"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="sync-chain-rail-thumb"]').classes()).toContain('start-0')
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[role="switch"]').attributes('aria-disabled')).toBeUndefined()
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['readAlong-audiobook', true])
  })

  it('disables an off switch with nothing to link and says why', async () => {
    const chain = chainOf({
      linked: false,
      ebook: chainSide({ book: chainBook(1, 'Ebook'), isThisBook: true }),
      audiobook: chainSide({ book: null }),
      readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    })
    const wrapper = mountConnector(connectorRow(chain, 'readAlong-audiobook'))

    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').text()).toContain('pick an audiobook first')
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-disabled')).toBe('true')
    expect(toggle.attributes('title')).toBe('pick an audiobook first')
    const reason = wrapper.get(`#${toggle.attributes('aria-describedby')}`)
    expect(reason.text()).toBe('pick an audiobook first')
    await toggle.trigger('click')
    expect(wrapper.emitted('toggle')).toBeUndefined()

    const noGhost = mountConnector(connectorRow(chainOf({ linked: false, audiobook: chainSide() }), 'ebook-audiobook'))
    expect(noGhost.get('[role="switch"]').attributes('title')).toBe('There is nothing to link yet.')
  })

  it('names why an Audiobookshelf match is off', () => {
    const paused = connectorRow(chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'excluded' }) }), 'audiobook-abs')
    const wrapper = mountConnector(paused)

    expect(wrapper.get('[data-testid="sync-chain-qualifier"]').text()).toContain('sync paused')
    expect(wrapper.find('[data-testid="sync-chain-abs-details"]').exists()).toBe(false)
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
  })

  it('centres every connector switch under the card covers, in both views', () => {
    const chain = readAlongChain({ abs: chainAbs() })
    for (const view of ['modify', 'compact'] as const) {
      // A card's cover column sits behind its 1px border and px-2 padding.
      for (const key of ['readAlong-audiobook', 'ebook-audiobook'] as const) {
        const classes = mountConnector(connectorRow(chain, key), view).get('[data-testid="sync-chain-connector"]').classes()
        expect(classes).toContain('ps-[9px]')
      }
      // Inside the audio box the box's own border already supplies the 1px.
      const inner = mountConnector(connectorRow(chain, 'audiobook-abs'), view).get('[data-testid="sync-chain-connector"]').classes()
      expect(inner).toContain('ps-2')
      expect(inner).not.toContain('px-0')
    }
  })

  it('draws the inner Audiobookshelf connector with a small switch and row in Modify', () => {
    const chain = readAlongChain({ abs: chainAbs() })
    const inner = mountConnector(connectorRow(chain, 'audiobook-abs'))
    const outer = mountConnector(connectorRow(chain, 'ebook-audiobook'))

    expect(inner.get('[data-testid="sync-chain-connector"]').classes()).toContain('min-h-7')
    expect(outer.get('[data-testid="sync-chain-connector"]').classes()).toContain('min-h-8')
    const innerSwitch = inner.get('[role="switch"]')
    expect(innerSwitch.classes()).toEqual(expect.arrayContaining(['h-4', 'w-7']))
    expect(innerSwitch.get('[data-testid="sync-chain-rail-thumb"]').classes()).toEqual(expect.arrayContaining(['size-3', 'start-3']))
    expect(inner.get('[data-testid="sync-chain-rail"]').classes()).toContain('w-9')
    const outerSwitch = outer.get('[role="switch"]')
    expect(outerSwitch.classes()).toEqual(expect.arrayContaining(['h-5', 'w-9']))
    expect(outerSwitch.get('[data-testid="sync-chain-rail-thumb"]').classes()).toEqual(expect.arrayContaining(['size-4', 'start-4']))
  })

  it('draws a size-5 node for an inner connector without a switch in Modify', () => {
    const chain = readAlongChain({ abs: chainAbs({ syncing: false, pausedReason: 'excluded' }) })
    const row = { ...connectorRow(chain, 'audiobook-abs'), switch: null }
    expect(mountConnector(row).get('[data-testid="sync-chain-node"]').classes()).toContain('size-5')
  })

  it('draws a smaller node and row for the inner connector in compact', () => {
    const chain = readAlongChain({ abs: chainAbs() })
    const inner = mountConnector(connectorRow(chain, 'audiobook-abs'), 'compact')
    const outer = mountConnector(connectorRow(chain, 'ebook-audiobook'), 'compact')

    expect(inner.get('[data-testid="sync-chain-node"]').classes()).toContain('size-4')
    expect(outer.get('[data-testid="sync-chain-node"]').classes()).toContain('size-5')
    expect(inner.html()).toContain('min-h-[26px]')
    expect(outer.html()).toContain('min-h-[30px]')
  })

  it('says a linked Audiobookshelf is synced in a muted compact line and nothing for the spine pair', () => {
    const chain = readAlongChain({ abs: chainAbs() })
    const mini = mountConnector(connectorRow(chain, 'audiobook-abs'), 'compact').get('[data-testid="sync-chain-mini-text"]')

    expect(mini.text()).toBe('Synced with Audiobookshelf')
    expect(mini.classes()).toContain('text-muted-foreground')
    expect(mountConnector(connectorRow(chain, 'ebook-audiobook'), 'compact').find('[data-testid="sync-chain-mini-text"]').exists()).toBe(false)
  })

  it('does not say synced for an unreachable Audiobookshelf', () => {
    const chain = readAlongChain({ abs: chainAbs({}, absLive({ status: 'unreachable', progress: null })) })
    const text = mountConnector(connectorRow(chain, 'audiobook-abs'), 'compact').get('[data-testid="sync-chain-mini-text"]').text()

    expect(text).not.toContain('Synced')
    expect(text).toContain('reach')
  })

  it('draws the un-generated read-along connector as a bare muted node without a switch or chevron', () => {
    const chain = chainOf()
    const row = connectorRow(chain, 'readAlong-audiobook')
    const modify = mountConnector(row)

    expect(modify.find('[role="switch"]').exists()).toBe(false)
    expect(modify.find('[data-testid="sync-chain-explain-toggle"]').exists()).toBe(false)
    expect(modify.get('[data-testid="sync-chain-node"]').classes()).toContain('size-7')
    expect(modify.get('[data-testid="sync-chain-qualifier"]').text()).toBe('not generated')
    const compact = mountConnector(row, 'compact')
    expect(compact.find('[data-testid="sync-chain-mini-text"]').exists()).toBe(false)
    expect(compact.find('[data-testid="sync-chain-node"]').exists()).toBe(true)
  })

  it('keeps the full-size switch on the generated read-along connector', () => {
    const row = connectorRow(readAlongChain(), 'readAlong-audiobook')
    const sw = mountConnector(row).get('[role="switch"]')

    expect(row.frame).toBe('spine')
    expect(sw.classes()).toEqual(expect.arrayContaining(['h-5', 'w-9']))
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
    expect(wrapper.get('[data-testid="sync-chain-abs-hint"]').text()).toContain('Progress catches up when Audiobookshelf is back.')
    expect(wrapper.find('[data-action="retryAbs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sync-chain-abs-settings"]').exists()).toBe(true)
  })

  it('disables the switch while something is busy or without the edit permission', () => {
    expect(mountConnector(pairRow(), 'modify', { busy: true }).get('[role="switch"]').attributes('aria-disabled')).toBe('true')
    const readOnly = connectorRow(chainOf({ can: { editLink: false, generate: true, rebuild: true } }), 'ebook-audiobook')
    expect(mountConnector(readOnly).get('[role="switch"]').attributes('aria-disabled')).toBe('true')
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

    it('names an off link in one line without an action', () => {
      const chain = chainOf({ readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 3, title: 'Read-along' } }) })
      const wrapper = mountConnector(connectorRow(chain, 'readAlong-audiobook'), 'compact')

      expect(wrapper.get('[data-testid="sync-chain-mini-text"]').text()).toBe('not linked')
      expect(wrapper.find('[data-testid="sync-chain-action"]').exists()).toBe(false)
    })

    it('reads the mini text from the catalog', async () => {
      await withMessages({ book: { detail: { editionLink: { chain: { mini: { linking: 'Mapping…' } } } } } }, () => {
        const wrapper = mountConnector(pairRow(chainAlignment({ running: true, builtAt: null })), 'compact')

        expect(wrapper.get('[data-testid="sync-chain-mini-text"]').text()).toBe('Mapping…')
      })
    })
  })

  describe('compact out-of-sync Audiobookshelf row', () => {
    const divergedLive = () => absLive({ status: 'diverged' })
    const divergedRow = () => connectorRow(chainOf({ abs: chainAbs({}, divergedLive()) }), 'audiobook-abs')

    it('offers the chevron and opens the reconcile details under the row', async () => {
      const wrapper = mountConnector(divergedRow(), 'compact', { absLive: divergedLive() })

      expect(wrapper.get('[data-testid="sync-chain-mini-text"]').text()).toBe('Out of sync')
      expect(wrapper.find('[data-testid="sync-chain-abs-details"]').exists()).toBe(false)
      const toggle = wrapper.get('[data-testid="sync-chain-explain-toggle"]')
      expect(toggle.attributes('aria-expanded')).toBe('false')

      await toggle.trigger('click')

      expect(toggle.attributes('aria-expanded')).toBe('true')
      const details = wrapper.get('[data-testid="sync-chain-abs-details"]')
      expect(toggle.attributes('aria-controls')).toBe(details.attributes('id'))
      expect(details.findAll('[data-action]').map((button) => button.attributes('data-action'))).toEqual(['absPush', 'absPull'])
    })

    it('keeps the chevron off a compact Audiobookshelf row that is in sync', () => {
      const wrapper = mountConnector(connectorRow(chainOf({ abs: chainAbs() }), 'audiobook-abs'), 'compact')

      expect(wrapper.find('[data-testid="sync-chain-explain-toggle"]').exists()).toBe(false)
    })

    it('locks Send to ABS and Use ABS while the panel is busy', () => {
      const wrapper = mountConnector(divergedRow(), 'modify', { absLive: divergedLive(), busy: true })

      for (const id of ['absPush', 'absPull']) expect(wrapper.get(`[data-action="${id}"]`).attributes('aria-disabled')).toBe('true')
    })

    it('does not open the reconcile details from a Modify explainer left open before the state changed', async () => {
      const inSync = connectorRow(chainOf({ abs: chainAbs() }), 'audiobook-abs')
      const wrapper = mountConnector(inSync, 'modify')
      await wrapper.get('[data-testid="sync-chain-explain-toggle"]').trigger('click')
      expect(wrapper.find('[data-testid="sync-chain-explainer"]').exists()).toBe(true)

      await wrapper.setProps({ row: divergedRow(), view: 'compact', absLive: divergedLive() })

      expect(wrapper.get('[data-testid="sync-chain-explain-toggle"]').attributes('aria-expanded')).toBe('false')
      expect(wrapper.find('[data-testid="sync-chain-abs-details"]').exists()).toBe(false)
    })

    it('closes the Modify explainer when the state changes', async () => {
      const oneWay = connectorRow(chainOf({ abs: chainAbs({ direction: 'from_abs' }) }), 'audiobook-abs')
      const twoWay = connectorRow(chainOf({ abs: chainAbs() }), 'audiobook-abs')
      expect(oneWay.state).not.toBe(twoWay.state)
      const wrapper = mountConnector(oneWay, 'modify')
      await wrapper.get('[data-testid="sync-chain-explain-toggle"]').trigger('click')

      await wrapper.setProps({ row: twoWay })

      expect(wrapper.find('[data-testid="sync-chain-explainer"]').exists()).toBe(false)
    })

    it.each(['compact', 'modify'] as const)('keeps focus on the %s row when a landed reconcile removes a button held busy', async (view) => {
      const wrapper = mount(SyncChainConnector, {
        props: { row: divergedRow(), view, absLive: divergedLive(), absBusy: 'push' },
        global: { stubs },
        attachTo: document.body,
      })
      if (view === 'compact') await wrapper.get('[data-testid="sync-chain-explain-toggle"]').trigger('click')
      ;(wrapper.get('[data-action="absPush"]').element as HTMLElement).focus()

      await wrapper.setProps({ row: connectorRow(chainOf({ abs: chainAbs() }), 'audiobook-abs'), absLive: absLive(), absBusy: null })
      await nextTick()

      expect(wrapper.find('[data-action="absPush"]').exists()).toBe(false)
      expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-connector"]').element)
      wrapper.unmount()
    })

    it.each(['compact', 'modify'] as const)('keeps focus on the %s row when a landed reconcile removes the focused button', async (view) => {
      const wrapper = mount(SyncChainConnector, {
        props: { row: divergedRow(), view, absLive: divergedLive() },
        global: { stubs },
        attachTo: document.body,
      })
      if (view === 'compact') await wrapper.get('[data-testid="sync-chain-explain-toggle"]').trigger('click')
      ;(wrapper.get('[data-action="absPush"]').element as HTMLElement).focus()

      await wrapper.setProps({ row: connectorRow(chainOf({ abs: chainAbs() }), 'audiobook-abs'), absLive: absLive() })
      await nextTick()

      expect(wrapper.find('[data-action="absPush"]').exists()).toBe(false)
      expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-connector"]').element)
      wrapper.unmount()
    })
  })
})
