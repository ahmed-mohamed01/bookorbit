import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainAvailableRow, SyncChainSnapshot } from '@/features/book/lib/sync-chain'
import EditionCover from '../EditionCover.vue'
import ReadAlongBuildOptions from '../ReadAlongBuildOptions.vue'
import SyncChainAvailableRow from '../SyncChainAvailableRow.vue'
import {
  availableRow,
  chainAbs,
  chainAlignment,
  chainBook,
  chainOf,
  chainReadAlong,
  chainSide,
} from '@/features/book/lib/__tests__/sync-chain-fixtures'

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } }

const options = {
  targetLibraries: [{ id: 4, name: 'Readalouds' }],
  chosenTargetLibraryId: null,
  targetLibraryName: 'Readalouds',
  keepRemoteCopy: false,
  reclaimable: true,
  existingMatch: null,
  busy: false,
} as unknown as SyncChainPanelView['readAlongOptions']

function mountRow(row: ChainAvailableRow, props: { expanded?: boolean; logOpen?: boolean; busy?: boolean } = {}) {
  return mount(SyncChainAvailableRow, { props: { row, options, ...props }, global: { stubs } })
}

const note = (wrapper: ReturnType<typeof mountRow>) => wrapper.get('[data-testid="sync-chain-available-note"]').text()

/** Ebook page before a link, with the audiobook side as given. */
function unlinked(audiobook = chainSide(), overrides: Partial<SyncChainSnapshot> = {}) {
  return chainOf({
    linked: false,
    ebook: chainSide({ book: chainBook(1, 'Ebook'), isThisBook: true }),
    audiobook,
    alignment: chainAlignment({ status: 'none', builtAt: null }),
    ...overrides,
  })
}

const readAlongRow = (readAlong = chainReadAlong(), overrides: Partial<SyncChainSnapshot> = {}) =>
  availableRow(chainOf({ readAlong, ...overrides }), 'readAlong')

describe('SyncChainAvailableRow', () => {
  it('draws a dashed shell and never fades the row', () => {
    const wrapper = mountRow(readAlongRow())

    const shell = wrapper.get('[data-testid="sync-chain-available-row"] > div')
    expect(shell.classes()).toEqual(expect.arrayContaining(['border-dashed', 'rounded-xl']))
    for (const element of [wrapper.get('[data-testid="sync-chain-available-row"]'), shell]) {
      expect(element.classes().some((name) => name.startsWith('opacity-'))).toBe(false)
    }
  })

  describe('candidates', () => {
    it('offers an auto match with Link and Not this one?', async () => {
      const row = availableRow(unlinked(chainSide({ book: chainBook(2, 'Dune (audio)'), match: { source: 'auto', score: 96 } })), 'audiobook')
      const wrapper = mountRow(row)

      expect(wrapper.text()).toContain('Audiobook')
      expect(note(wrapper)).toBe('96% match · Dune (audio)')
      expect(wrapper.getComponent(EditionCover).props()).toMatchObject({ bookId: 2, medium: 'audio', size: 'mini', muted: true })
      await wrapper.get('[data-action="linkPair"]').trigger('click')
      await wrapper.get('[data-action="openSearch"]').trigger('click')
      expect(wrapper.emitted('action')).toEqual([
        ['linkPair', 'available:audiobook'],
        ['openSearch', 'available:audiobook'],
      ])
    })

    it('marks a pick as selected, and names an untitled one', () => {
      const picked = availableRow(unlinked(chainSide({ book: chainBook(2, 'Messiah'), match: { source: 'manual' } })), 'audiobook')
      expect(note(mountRow(picked))).toBe('Selected · Messiah')

      const untitled = availableRow(unlinked(chainSide({ book: chainBook(2, null), match: { source: 'auto', score: 80 } })), 'audiobook')
      expect(note(mountRow(untitled))).toBe('80% match · Untitled')
    })

    it("offers a read-along's own pair with no other choice", () => {
      const chain = chainOf({
        thisBook: 'readAlong',
        linked: false,
        ebook: chainSide({ book: chainBook(1, 'Ebook'), match: { source: 'pair' } }),
        audiobook: chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'pair' } }),
        readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } }),
      })
      const wrapper = mountRow(availableRow(chain, 'ebook'))

      expect(note(wrapper)).toBe('Generated from · Ebook')
      expect(wrapper.find('[data-action="openSearch"]').exists()).toBe(false)
    })

    it('locks Link for a reader who cannot link, pointing at the note', () => {
      const row = availableRow(
        unlinked(chainSide({ book: chainBook(2, 'Dune (audio)'), match: { source: 'auto', score: 96 } }), {
          can: { editLink: false, generate: false, rebuild: false },
        }),
        'audiobook',
      )
      const wrapper = mountRow(row)

      const link = wrapper.get('[data-action="linkPair"]')
      expect(link.attributes('disabled')).toBeDefined()
      expect(wrapper.get(`[id="${link.attributes('aria-describedby')}"]`).text()).toBe('96% match · Dune (audio)')
    })
  })

  it('offers a search without a cover when nothing matched, showing the search once expanded', () => {
    const row = availableRow(unlinked(), 'audiobook')
    const wrapper = mount(SyncChainAvailableRow, {
      props: { row, expanded: true },
      slots: { default: '<div data-testid="search-slot" />' },
      global: { stubs },
    })

    expect(note(wrapper)).toBe('No matching audiobook found yet')
    expect(wrapper.findComponent(EditionCover).exists()).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-read-along-tile"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-abs-cover"]').exists()).toBe(false)
    expect(wrapper.get('[data-action="openSearch"]').text()).toBe('Search')
    expect(wrapper.find('[data-testid="search-slot"]').exists()).toBe(true)
  })

  describe('while the panel is busy', () => {
    it('disables the action and the secondary link', () => {
      const row = availableRow(unlinked(chainSide({ book: chainBook(2, 'Dune (audio)'), match: { source: 'auto', score: 96 } })), 'audiobook')
      const wrapper = mountRow(row, { busy: true })

      expect(wrapper.get('[data-action="linkPair"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-action="openSearch"]').attributes('disabled')).toBeDefined()
    })

    it('disables the cancel X of a job in flight', () => {
      const row = readAlongRow(chainReadAlong({ status: 'queued', queuePosition: 2 }))

      expect(mountRow(row).get('[data-action="cancelReadAlong"]').attributes('disabled')).toBeUndefined()
      expect(mountRow(row, { busy: true }).get('[data-action="cancelReadAlong"]').attributes('disabled')).toBeDefined()
    })
  })

  describe('read-along', () => {
    it('says how far down the queue a build is, with its stepper and cancel', async () => {
      const wrapper = mountRow(readAlongRow(chainReadAlong({ status: 'queued', queuePosition: 2 })))

      expect(note(wrapper)).toBe('Waiting for another read-along to finish (2 in line)')
      expect(wrapper.find('[data-testid="read-along-stepper"]').exists()).toBe(true)
      await wrapper.get('[data-action="cancelReadAlong"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['cancelReadAlong', 'available:readAlong'])
    })

    it('narrates a build in progress', () => {
      const wrapper = mountRow(readAlongRow(chainReadAlong({ status: 'building', phase: 'wait', remoteTask: 'TRANSCRIBE', remoteProgress: 0.4 })))

      expect(note(wrapper)).toBe('Generating with Storyteller…')
      expect(wrapper.get('[data-testid="read-along-percent"]').text()).toBe('40%')
    })

    it('names the stage a failed build stopped at, and shows its log on request', async () => {
      const failed = readAlongRow(chainReadAlong({ status: 'failed', phase: 'wait', remoteTask: 'TRANSCRIBE', error: 'out of memory' }))
      const closed = mountRow(failed)

      expect(note(closed)).toBe('Storyteller stopped at the Transcribing step. Nothing was added to your library.')
      expect(closed.find('[data-testid="read-along-stepper"]').exists()).toBe(false)
      expect(closed.find('[data-testid="sync-chain-available-log"]').exists()).toBe(false)
      await closed.get('[data-action="toggleLog"]').trigger('click')
      expect(closed.emitted('action')?.[0]).toEqual(['toggleLog', 'available:readAlong'])

      const open = mountRow(failed, { logOpen: true })
      expect(open.get('[data-testid="sync-chain-available-log"]').text()).toBe('out of memory')
      expect(open.get('[data-action="toggleLog"]').text()).toBe('Hide log')
      expect(open.find('[data-action="retryReadAlong"]').exists()).toBe(true)
    })

    it('offers a detached read-along back with Link', () => {
      const wrapper = mountRow(readAlongRow(chainReadAlong({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } })))

      expect(note(wrapper)).toBe('Generated · not syncing')
      expect(wrapper.get('[data-action="attachReadAlong"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.getComponent(EditionCover).props()).toMatchObject({ bookId: 30, muted: true })
    })

    it('holds a read-along whose pair is not linked', () => {
      const chain = unlinked(chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'auto', score: 90 } }), {
        readAlong: chainReadAlong({ status: 'ready', outputBook: { id: 30, title: 'Read-along' } }),
      })
      const wrapper = mountRow(availableRow(chain, 'readAlong'))

      expect(note(wrapper)).toBe('Generated · rejoins when the ebook and audiobook are linked')
      expect(wrapper.get('[data-action="attachReadAlong"]').attributes('disabled')).toBeDefined()
    })

    it('says a ready read-along is out of reach when its book is hidden', () => {
      expect(note(mountRow(readAlongRow(chainReadAlong({ status: 'ready' }))))).toBe("Added to a library you can't open.")
    })

    it('asks for the pair before a build', () => {
      const chain = unlinked(chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'auto', score: 90 } }))
      const wrapper = mountRow(availableRow(chain, 'readAlong'))

      expect(note(wrapper)).toBe('Link the ebook and audiobook first')
      expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
    })

    it('names what blocks a build', () => {
      const wrapper = mountRow(readAlongRow(chainReadAlong({ blocked: 'no_target_library' })))

      expect(note(wrapper)).toBe('Pick a read-along library in the Storyteller settings.')
      expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
    })

    it('opens the generate options on the first tap and commits on the second', async () => {
      const row = readAlongRow()
      const collapsed = mountRow(row)
      expect(note(collapsed)).toBe('Not generated · Storyteller builds it from the ebook and audiobook')
      expect(collapsed.findComponent(ReadAlongBuildOptions).exists()).toBe(false)
      await collapsed.get('[data-action="openGenerate"]').trigger('click')
      expect(collapsed.emitted('action')?.[0]).toEqual(['openGenerate', 'available:readAlong'])

      const expanded = mountRow(row, { expanded: true })
      const block = expanded.getComponent(ReadAlongBuildOptions)
      expect(block.props()).toMatchObject({ targetLibraryName: 'Readalouds', reclaimable: true })
      block.vm.$emit('generate')
      block.vm.$emit('cancel')
      block.vm.$emit('update:keepRemoteCopy', true)
      expect(expanded.emitted('action')).toEqual([
        ['generate', 'available:readAlong'],
        ['cancelGenerate', 'available:readAlong'],
      ])
      expect(expanded.emitted('update:keepRemoteCopy')?.[0]).toEqual([true])
    })
  })

  describe('Audiobookshelf', () => {
    it('resumes a paused match', async () => {
      const row = availableRow(chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'excluded' }, null) }), 'abs')
      const wrapper = mountRow(row)

      expect(wrapper.text()).toContain('Audiobookshelf')
      expect(note(wrapper)).toBe('Sync paused · Fiction')
      expect(wrapper.find('[data-testid="sync-chain-abs-cover"]').exists()).toBe(true)
      await wrapper.get('[data-action="resumeAbs"]').trigger('click')
      expect(wrapper.emitted('action')?.[0]).toEqual(['resumeAbs', 'available:abs'])
    })

    it('confirms a match under review', () => {
      const row = availableRow(chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'needs_review' }, null) }), 'abs')
      const wrapper = mountRow(row)

      expect(note(wrapper)).toBe('Match needs review · Fiction')
      expect(wrapper.get('[data-action="confirmAbs"]').text()).toBe('Confirm')
    })

    it('points at Settings when position sync is off', () => {
      const row = availableRow(chainOf({ abs: chainAbs({ syncing: false, pausedReason: 'position_sync_off' }, null) }), 'abs')
      const wrapper = mountRow(row)

      expect(note(wrapper)).toBe('Position sync is off in Settings')
      expect(wrapper.find('[data-testid="sync-chain-available-settings"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="sync-chain-action"]').exists()).toBe(false)
    })

    it('waits for the audiobook to be linked', () => {
      const chain = unlinked(chainSide({ book: chainBook(2, 'Audiobook'), match: { source: 'auto', score: 90 } }), { abs: chainAbs() })
      const wrapper = mountRow(availableRow(chain, 'abs'))

      expect(note(wrapper)).toBe('Link the audiobook first')
      expect(wrapper.get('[data-action="resumeAbs"]').attributes('disabled')).toBeDefined()
    })
  })
})
