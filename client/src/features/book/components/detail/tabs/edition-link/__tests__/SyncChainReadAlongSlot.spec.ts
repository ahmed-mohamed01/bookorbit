import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainReadAlongSlotRow, SyncChainSnapshot } from '@/features/book/lib/sync-chain'
import ReadAlongBuildOptions from '../ReadAlongBuildOptions.vue'
import ReadAlongStepper from '../ReadAlongStepper.vue'
import SyncChainReadAlongSlot from '../SyncChainReadAlongSlot.vue'
import { chainAlignment, chainBook, chainOf, chainReadAlong, chainSide, slotRow } from '@/features/book/lib/__tests__/sync-chain-fixtures'

const options = {
  targetLibraries: [{ id: 4, name: 'Readalouds' }],
  chosenTargetLibraryId: null,
  targetLibraryName: 'Readalouds',
  keepRemoteCopy: false,
  reclaimable: true,
  existingMatch: null,
  busy: false,
} as unknown as SyncChainPanelView['readAlongOptions']

function mountSlot(row: ChainReadAlongSlotRow, props: { expanded?: boolean; logOpen?: boolean; busy?: boolean } = {}) {
  return mount(SyncChainReadAlongSlot, { props: { row, options, ...props } })
}

const slotOf = (readAlong = chainReadAlong(), overrides: Partial<SyncChainSnapshot> = {}) => slotRow(chainOf({ readAlong, ...overrides }))
const note = (wrapper: ReturnType<typeof mountSlot>) => wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()

const unlinked = (overrides: Partial<SyncChainSnapshot> = {}) =>
  chainOf({
    linked: false,
    ebook: chainSide({ book: chainBook(1, 'Ebook'), isThisBook: true }),
    audiobook: chainSide({ book: chainBook(2, 'Audio'), match: { source: 'manual' } }),
    alignment: chainAlignment({ status: 'none', builtAt: null }),
    ...overrides,
  })

describe('SyncChainReadAlongSlot', () => {
  it('draws a dashed slot, never faded, with the read-along tile', () => {
    const wrapper = mountSlot(slotOf())

    const root = wrapper.get('[data-testid="sync-chain-read-along-slot"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['border-dashed', 'rounded-xl']))
    expect(root.classes().some((name) => name.startsWith('opacity-'))).toBe(false)
    expect(wrapper.find('[data-testid="sync-chain-read-along-tile"]').exists()).toBe(true)
  })

  describe('not generated', () => {
    it('offers Generate, which only asks to open the options', async () => {
      const wrapper = mountSlot(slotOf())

      expect(wrapper.attributes('data-variant')).toBe('notGenerated')
      expect(note(wrapper)).toBe('Not generated. Storyteller builds it from the ebook and audiobook above.')
      await wrapper.get('[data-action="openGenerate"]').trigger('click')

      expect(wrapper.emitted('action')).toEqual([['openGenerate', 'slot:readAlong']])
    })

    it('swaps Generate for the options block when expanded, and builds only from its button', async () => {
      const wrapper = mountSlot(slotOf(), { expanded: true })

      expect(wrapper.find('[data-action="openGenerate"]').exists()).toBe(false)
      const block = wrapper.getComponent(ReadAlongBuildOptions)
      expect(block.props()).toMatchObject({ targetLibraryName: 'Readalouds', reclaimable: true, keepRemoteCopy: false })
      expect(wrapper.text()).toContain('Storyteller can take an hour or more.')
      expect(wrapper.text()).toContain('Will be added to Readalouds')

      await wrapper.get('[data-testid="read-along-generate"]').trigger('click')
      await wrapper.get('[data-testid="read-along-options-cancel"]').trigger('click')
      expect(wrapper.emitted('action')).toEqual([
        ['generate', 'slot:readAlong'],
        ['cancelGenerate', 'slot:readAlong'],
      ])
      expect(wrapper.get('[data-testid="read-along-generate"]').text()).toBe('Generate read-along')
    })

    it('moves focus into the options when they open and back to Generate when they close', async () => {
      const wrapper = mount(SyncChainReadAlongSlot, { props: { row: slotOf(), options }, attachTo: document.body })

      await wrapper.setProps({ expanded: true })
      await nextTick()
      expect(document.activeElement).toBe(wrapper.get('[data-testid="read-along-generate"]').element)

      await wrapper.setProps({ expanded: false })
      await nextTick()
      expect(document.activeElement).toBe(wrapper.get('[data-action="openGenerate"]').element)
      wrapper.unmount()
    })

    it('keeps focus inside the slot when the options close on a disabled Generate', async () => {
      const wrapper = mount(SyncChainReadAlongSlot, { props: { row: slotOf(), options, expanded: true }, attachTo: document.body })
      await nextTick()

      await wrapper.setProps({ expanded: false, busy: true })
      await nextTick()

      expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
      expect(document.activeElement).not.toBe(document.body)
      expect(wrapper.element.contains(document.activeElement)).toBe(true)
      wrapper.unmount()
    })

    it('forwards the destination and keep-copy choices and the import offer', async () => {
      const wrapper = mountSlot(slotOf(), { expanded: true })
      const block = wrapper.getComponent(ReadAlongBuildOptions)

      block.vm.$emit('update:keepRemoteCopy', true)
      block.vm.$emit('update:targetLibraryId', 4)
      block.vm.$emit('importExisting')

      expect(wrapper.emitted('update:keepRemoteCopy')).toEqual([[true]])
      expect(wrapper.emitted('update:targetLibraryId')).toEqual([[4]])
      expect(wrapper.emitted('action')).toEqual([['importExisting', 'slot:readAlong']])
    })

    it('ignores expanded for a slot that cannot generate yet', () => {
      const wrapper = mountSlot(slotOf(chainReadAlong(), { linked: false, ebook: chainSide(), audiobook: chainSide() }), { expanded: true })

      expect(wrapper.find('[data-testid="read-along-build-options"]').exists()).toBe(false)
    })
  })

  it('needs a pair: the same Generate when both editions are known but unlinked', () => {
    const wrapper = mountSlot(slotRow(unlinked()))

    expect(wrapper.attributes('data-variant')).toBe('notGenerated')
    expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeUndefined()
  })

  it('needs an ebook: asks for a pick in the slot above and disables Generate', () => {
    const wrapper = mountSlot(slotRow(unlinked({ ebook: chainSide() })))

    expect(wrapper.attributes('data-variant')).toBe('needsEbook')
    expect(note(wrapper)).toBe('Not generated. Pick an ebook in the slot above first.')
    expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="openGenerate"]').attributes('aria-describedby')).toBe(
      wrapper.get('[data-testid="sync-chain-placeholder-note"]').attributes('id'),
    )
  })

  it('needs an audiobook: asks to link one first and disables Generate', () => {
    const wrapper = mountSlot(slotRow(unlinked({ audiobook: chainSide() })))

    expect(wrapper.attributes('data-variant')).toBe('needsAudio')
    expect(note(wrapper)).toBe('Not generated. Pick an audiobook first.')
    expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
  })

  it('explains a blocked Storyteller and disables Generate', () => {
    const wrapper = mountSlot(slotOf(chainReadAlong({ blocked: 'unreachable' })))

    expect(wrapper.attributes('data-variant')).toBe('blocked')
    expect(note(wrapper)).toBe("The Storyteller server can't be reached.")
    expect(wrapper.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
  })

  it('shows the stepper and a cancel while queued or building', async () => {
    const building = mountSlot(slotOf(chainReadAlong({ status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS' })))

    expect(building.attributes('data-variant')).toBe('building')
    expect(note(building)).toBe('Generating with Storyteller…')
    expect(building.getComponent(ReadAlongStepper).props()).toMatchObject({ stage: 2, failed: false })
    expect(building.find('[data-action="openGenerate"]').exists()).toBe(false)
    await building.get('[data-action="cancelReadAlong"]').trigger('click')
    expect(building.emitted('action')?.[0]).toEqual(['cancelReadAlong', 'slot:readAlong'])

    const queued = mountSlot(slotOf(chainReadAlong({ status: 'queued', queuePosition: 2 })))
    expect(note(queued)).toBe('Waiting for another read-along to finish (2 in line)')
    expect(queued.getComponent(ReadAlongStepper).props('stage')).toBe(0)
  })

  it('offers no cancel once Storyteller is importing', () => {
    const wrapper = mountSlot(slotOf(chainReadAlong({ status: 'building', phase: 'collect' })))

    expect(wrapper.find('[data-action="cancelReadAlong"]').exists()).toBe(false)
    expect(wrapper.getComponent(ReadAlongStepper).props('stage')).toBe(3)
  })

  describe('failed', () => {
    const failed = () => slotOf(chainReadAlong({ status: 'failed', phase: 'wait', remoteTask: 'TRANSCRIBE', error: 'boom' }))

    it('names the step, offers Retry, and shows the log only when asked', async () => {
      const wrapper = mountSlot(failed())

      expect(note(wrapper)).toContain('Storyteller stopped at the Transcribing step. Nothing was added to your library.')
      expect(wrapper.find('[data-testid="sync-chain-slot-log"]').exists()).toBe(false)
      const log = wrapper.get('[data-action="toggleLog"]')
      expect(log.text()).toBe('View log')
      await log.trigger('click')
      await wrapper.get('[data-action="retryReadAlong"]').trigger('click')

      expect(wrapper.emitted('action')).toEqual([
        ['toggleLog', 'slot:readAlong'],
        ['retryReadAlong', 'slot:readAlong'],
      ])
    })

    it('shows the error and Hide log while the log is open', () => {
      const wrapper = mountSlot(failed(), { logOpen: true })

      expect(wrapper.get('[data-testid="sync-chain-slot-log"]').text()).toBe('boom')
      expect(wrapper.get('[data-action="toggleLog"]').text()).toBe('Hide log')
    })

    it('offers no log without an error and disables Retry while blocked', () => {
      const wrapper = mountSlot(slotOf(chainReadAlong({ status: 'failed', blocked: 'unreachable' })))

      expect(wrapper.find('[data-action="toggleLog"]').exists()).toBe(false)
      expect(wrapper.get('[data-action="retryReadAlong"]').attributes('disabled')).toBeDefined()
    })
  })

  it('holds the build options while the panel is busy', () => {
    const wrapper = mountSlot(slotOf(), { expanded: true, busy: true })

    expect(wrapper.getComponent(ReadAlongBuildOptions).props('busy')).toBe(true)
    expect(wrapper.get('[data-testid="read-along-generate"]').attributes('disabled')).toBeDefined()
  })

  it("renders a failed build's Dismiss as a labelled button next to Retry", async () => {
    const row = {
      ...slotOf(chainReadAlong({ status: 'failed', phase: 'wait', remoteTask: 'TRANSCRIBE', error: 'boom' })),
      cancel: { id: 'cancelReadAlong' as const, label: { key: 'book.detail.editionLink.readAlong.cancelLabel' }, disabled: false },
    }
    const wrapper = mountSlot(row)

    const dismiss = wrapper.get('[data-action="cancelReadAlong"]')
    expect(dismiss.text()).toBe('Cancel read-along build')
    expect(dismiss.find('svg').exists()).toBe(false)
    await dismiss.trigger('click')
    expect(wrapper.emitted('action')).toEqual([['cancelReadAlong', 'slot:readAlong']])
  })

  it('disables its actions while the panel is busy', () => {
    expect(mountSlot(slotOf(), { busy: true }).get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
  })

  it('always renders its Modify form: full note and the Generate button', () => {
    const wrapper = mountSlot(slotOf())

    const root = wrapper.get('[data-testid="sync-chain-read-along-slot"]')
    expect(root.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border-dashed']))
    expect(root.classes()).not.toContain('mt-2')
    expect(root.attributes('data-view')).toBe('modify')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').classes()).not.toContain('truncate')
    const action = wrapper.get('[data-action="openGenerate"]')
    expect(action.text()).toBe('Generate')
    expect(action.classes()).toContain('border')
    expect(root.text()).toContain('Read-along')
    expect(root.text()).toContain('Not generated.')
  })
})
