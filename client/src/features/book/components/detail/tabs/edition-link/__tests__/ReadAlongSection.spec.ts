import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { EditionLinkMember, ReadAlongPhase, StorytellerExistingMatch } from '@bookorbit/types'
import type { ReadAlongSectionState } from '@/features/book/composables/useReadAlong'
import ReadAlongSection from '../ReadAlongSection.vue'
import { withMessages } from './with-messages'

const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialogStub',
  props: { open: { type: Boolean, default: false } },
  emits: ['confirm', 'cancel'],
  template: '<div />',
})

const stubs = {
  RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' },
  ConfirmDialog: ConfirmDialogStub,
}

function makeState(overrides: Partial<ReadAlongSectionState> = {}): ReadAlongSectionState {
  return {
    status: 'none',
    blocked: null,
    phase: null,
    transport: null,
    remoteTask: null,
    remoteProgress: null,
    targetLibraryName: null,
    remoteCopyBytes: { epub: null, audio: null, readAlong: null },
    keepRemoteCopy: false,
    remoteCopyReclaimable: true,
    hasOutputBook: false,
    error: null,
    mutating: false,
    ...overrides,
  }
}

function makeMember(overrides: Partial<EditionLinkMember> = {}): EditionLinkMember {
  return {
    id: 30,
    title: 'Dune (read-along)',
    authorName: 'Frank Herbert',
    coverVersion: null,
    progress: { percentage: 42, updatedAt: '2026-09-01T00:00:00.000Z' },
    narrationPercentage: 37,
    ...overrides,
  }
}

function makeMatch(overrides: Partial<StorytellerExistingMatch> = {}): StorytellerExistingMatch {
  return { uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94, ...overrides }
}

type SectionProps = InstanceType<typeof ReadAlongSection>['$props']

function mountSection(props: Partial<SectionProps> = {}) {
  return mount(ReadAlongSection, {
    props: {
      mode: 'manage',
      state: makeState(),
      member: null,
      canGenerate: true,
      canRebuild: true,
      keepCopyOffered: true,
      ...props,
    } as SectionProps,
    global: { stubs },
  })
}

function sectionState(wrapper: ReturnType<typeof mountSection>) {
  return wrapper.get('[data-testid="read-along-section"]').attributes('data-state')
}

function stageStates(wrapper: ReturnType<typeof mountSection>) {
  return wrapper.findAll('[data-testid="read-along-stage"]').map((stage) => [stage.text(), stage.attributes('data-stage-state')])
}

describe('ReadAlongSection', () => {
  describe('stages while building', () => {
    it.each([
      [null, null, 'Sending'],
      ['prepare', null, 'Sending'],
      ['register', null, 'Sending'],
      ['process', 'SPLIT_TRACKS', 'Sending'],
      ['wait', 'SPLIT_TRACKS', 'Transcribing'],
      ['wait', 'TRANSCRIBE_CHAPTERS', 'Transcribing'],
      ['wait', null, 'Transcribing'],
      ['wait', 'SOMETHING_NEW', 'Transcribing'],
      ['wait', 'sync_chapters', 'Aligning'],
      ['collect', 'SYNC_CHAPTERS', 'Importing'],
      ['link', null, 'Importing'],
    ] as [ReadAlongPhase | null, string | null, string][])('maps phase %s with task %s to %s', (phase, remoteTask, expected) => {
      const wrapper = mountSection({ state: makeState({ status: 'building', phase, remoteTask }) })

      const states = stageStates(wrapper)
      const currentIndex = states.findIndex(([, state]) => state === 'current')
      expect(states[currentIndex]?.[0]).toBe(expected)
      expect(states.slice(0, currentIndex).every(([, state]) => state === 'done')).toBe(true)
      expect(states.slice(currentIndex + 1).every(([, state]) => state === 'todo')).toBe(true)
    })

    it("shows Storyteller's own progress while it reports one", () => {
      const wrapper = mountSection({ state: makeState({ status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS', remoteProgress: 0.426 }) })

      expect(wrapper.get('[data-testid="read-along-percent"]').text()).toBe('43%')
      expect(wrapper.get('[data-testid="read-along-bar"]').attributes('aria-valuenow')).toBe('43')
      expect(wrapper.find('[data-testid="read-along-bar-indeterminate"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Building')
    })

    it('pulses without a percentage when no progress is reported, or once BookOrbit has taken over', () => {
      const unknown = mountSection({ state: makeState({ status: 'building', phase: 'wait', remoteProgress: null }) })
      expect(unknown.find('[data-testid="read-along-bar-indeterminate"]').exists()).toBe(true)
      expect(unknown.find('[data-testid="read-along-percent"]').exists()).toBe(false)

      const collecting = mountSection({ state: makeState({ status: 'building', phase: 'collect', remoteProgress: 1 }) })
      expect(collecting.find('[data-testid="read-along-bar-indeterminate"]').exists()).toBe(true)
    })

    it('reads the percentage from the catalog', async () => {
      await withMessages({ book: { detail: { editionLink: { readAlong: { percent: '{percent} %' } } } } }, () => {
        const wrapper = mountSection({ state: makeState({ status: 'building', phase: 'wait', remoteProgress: 0.5 }) })

        expect(wrapper.get('[data-testid="read-along-percent"]').text()).toBe('50 %')
      })
    })

    it('offers Cancel beside the Building tag and emits it', async () => {
      const wrapper = mountSection({ state: makeState({ status: 'building', phase: 'wait' }) })

      const cancel = wrapper.get('[data-testid="read-along-cancel"]')
      expect(cancel.text()).toBe('Cancel')
      expect(cancel.attributes('aria-label')).toBe('Cancel read-along build')
      expect(cancel.element.nextElementSibling?.getAttribute('data-testid')).toBe('read-along-tag')
      await cancel.trigger('click')
      expect(wrapper.emitted('cancel')).toHaveLength(1)
    })

    it('offers Cancel only while building and only with the upload permission', () => {
      expect(
        mountSection({ state: makeState({ status: 'building' }), canGenerate: false })
          .find('[data-testid="read-along-cancel"]')
          .exists(),
      ).toBe(false)
      expect(
        mountSection({ state: makeState({ status: 'none' }) })
          .find('[data-testid="read-along-cancel"]')
          .exists(),
      ).toBe(false)
      expect(
        mountSection({ state: makeState({ status: 'failed' }) })
          .find('[data-testid="read-along-cancel"]')
          .exists(),
      ).toBe(false)
      expect(
        mountSection({ state: makeState({ status: 'ready' }), member: makeMember() })
          .find('[data-testid="read-along-cancel"]')
          .exists(),
      ).toBe(false)
    })

    it.each(['collect', 'link'] as ReadAlongPhase[])('hides Cancel once the build is importing (%s)', (phase) => {
      const wrapper = mountSection({ state: makeState({ status: 'building', phase }) })

      expect(wrapper.find('[data-testid="read-along-cancel"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-tag"]').exists()).toBe(true)
    })

    it('offers no keep-copy choice once the build has started, since it would change nothing', () => {
      const wrapper = mountSection({ state: makeState({ status: 'building', phase: 'wait' }) })

      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)
    })
  })

  describe('with no read-along yet', () => {
    it('offers Generate and an aligned Storyteller import', async () => {
      const wrapper = mountSection({ existingMatch: makeMatch() })

      expect(sectionState(wrapper)).toBe('none')
      expect(wrapper.get('[data-testid="read-along-body"]').text()).toBe('Not generated yet.')
      expect(wrapper.get('[data-testid="read-along-generate"]').classes()).toContain('bg-primary')
      await wrapper.get('[data-testid="read-along-generate"]').trigger('click')
      expect(wrapper.emitted('generate')).toHaveLength(1)

      const importButton = wrapper.get('[data-testid="read-along-import"]')
      expect(importButton.text()).toBe('Import "Forward the Foundation" from Storyteller')
      expect(importButton.classes()).toEqual(expect.arrayContaining(['mt-2', 'text-pretty', 'text-start']))
      expect(importButton.classes()).not.toContain('truncate')
      await importButton.trigger('click')
      expect(wrapper.emitted('importExisting')?.[0]).toEqual(['uuid-1'])
    })

    it('ignores an unaligned Storyteller match', () => {
      const wrapper = mountSection({ existingMatch: makeMatch({ aligned: false }) })

      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
    })

    it('offers no action without the upload permission', () => {
      const wrapper = mountSection({ canGenerate: false, existingMatch: makeMatch(), state: makeState({ blocked: 'not_configured' }) })

      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-destination"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
    })
  })

  describe('block reasons', () => {
    it.each(['not_configured', 'unreachable'] as const)('tags %s as Unreachable and disables Generate with the reason', (blocked) => {
      const wrapper = mountSection({ state: makeState({ blocked }) })

      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Unreachable')
      expect(wrapper.get('[data-testid="read-along-generate"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(true)
    })

    it.each([
      ['no_target_library', 'Pick a read-along library'],
      ['previous_output_not_deletable', 'permission to delete books'],
    ] as const)('shows only the reason line for %s', (blocked, expected) => {
      const wrapper = mountSection({ state: makeState({ blocked }) })

      expect(wrapper.find('[data-testid="read-along-tag"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-blocked"]').text()).toContain(expected)
    })

    it('keeps Generate clickable while Storyteller is merely busy', () => {
      const wrapper = mountSection({ state: makeState({ blocked: 'busy' }) })

      expect(wrapper.get('[data-testid="read-along-generate"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.get('[data-testid="read-along-blocked"]').text()).toContain('busy')
    })
  })

  describe('keeping the Storyteller copy', () => {
    it('explains each choice and emits it', async () => {
      const kept = mountSection({ state: makeState({ keepRemoteCopy: true }) })
      expect(kept.get('[data-testid="read-along-keep-copy-hint"]').text()).toBe('Storyteller keeps its copy after BookOrbit imports the read-along.')

      const dropped = mountSection({ state: makeState({ keepRemoteCopy: false }) })
      expect(dropped.get('[data-testid="read-along-keep-copy-hint"]').text()).toBe(
        'Removed from Storyteller after import. BookOrbit keeps the only copy.',
      )

      await dropped.get('[data-testid="read-along-keep-copy"]').trigger('click')
      expect(dropped.emitted('update:keepRemoteCopy')?.[0]).toEqual([true])
    })

    it('renders nothing when there is no Storyteller copy to keep', () => {
      const wrapper = mountSection({ keepCopyOffered: false })

      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)
    })
  })

  describe('destination', () => {
    const libraries = [
      { id: 4, name: 'Read-alongs' },
      { id: 5, name: 'Fiction' },
    ]

    it('names the destination and reveals the select only after Change', async () => {
      const wrapper = mountSection({ targetLibraries: libraries, chosenTargetLibraryId: null, targetLibraryName: 'Read-alongs' })

      expect(wrapper.get('[data-testid="read-along-destination"]').text()).toContain('Will be added to Read-alongs')
      expect(wrapper.find('[data-testid="read-along-destination-select"]').exists()).toBe(false)

      await wrapper.get('[data-testid="read-along-destination-change"]').trigger('click')
      await wrapper.get('[data-testid="read-along-destination-select"]').setValue('5')

      expect(wrapper.emitted('update:targetLibraryId')?.[0]).toEqual([5])
    })

    // The configured library is only described, never chosen, so the select opens on the placeholder.
    // Picking that same library by name is still a choice, and its id is sent like any other.
    it('opens the select on the placeholder until a library is chosen', async () => {
      const wrapper = mountSection({ targetLibraries: libraries, chosenTargetLibraryId: null, targetLibraryName: 'Read-alongs' })

      await wrapper.get('[data-testid="read-along-destination-change"]').trigger('click')
      const select = wrapper.get('[data-testid="read-along-destination-select"]')
      expect((select.element as HTMLSelectElement).selectedIndex).toBe(0)
      expect(wrapper.get('[data-testid="read-along-destination"]').text()).toContain('Will be added to Read-alongs')

      await select.setValue('4')
      expect(wrapper.emitted('update:targetLibraryId')?.[0]).toEqual([4])
    })

    it('shows the chosen library in the select', async () => {
      const wrapper = mountSection({ targetLibraries: libraries, chosenTargetLibraryId: 5, targetLibraryName: 'Fiction' })

      await wrapper.get('[data-testid="read-along-destination-change"]').trigger('click')

      expect((wrapper.get('[data-testid="read-along-destination-select"]').element as HTMLSelectElement).selectedIndex).toBe(2)
    })

    it('falls back to a generic line when the library is unknown', () => {
      const wrapper = mountSection()

      expect(wrapper.get('[data-testid="read-along-destination"]').text()).toContain('Will be added to the read-along library')
      expect(wrapper.find('[data-testid="read-along-destination-change"]').exists()).toBe(false)
    })
  })

  describe('offering a build on link', () => {
    it('shows the toggle and the full offer once it is on', async () => {
      const off = mountSection({ mode: 'offer', canToggle: true, generateOnLink: false })
      expect(sectionState(off)).toBe('offerOff')
      expect(off.get('[data-testid="read-along-body"]').text()).toContain('You can build a read-along later')
      expect(off.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)
      expect(off.find('[data-testid="read-along-destination"]').exists()).toBe(false)
      await off.get('[data-testid="read-along-toggle"]').trigger('click')
      expect(off.emitted('update:generateOnLink')?.[0]).toEqual([true])

      const on = mountSection({ mode: 'offer', canToggle: true, generateOnLink: true })
      expect(sectionState(on)).toBe('offerOn')
      expect(on.get('[data-testid="read-along-body"]').text()).toContain('highlights the text')
      expect(on.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(true)
      expect(on.find('[data-testid="read-along-destination"]').exists()).toBe(true)
      expect(on.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })

    it('disables the toggle with the reason when it is blocked', () => {
      const wrapper = mountSection({
        mode: 'offer',
        canToggle: true,
        generateOnLink: true,
        toggleDisabled: true,
        state: makeState({ blocked: 'unreachable' }),
      })

      expect(sectionState(wrapper)).toBe('offerOff')
      expect(wrapper.get('[data-testid="read-along-toggle"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Unreachable')
      expect(wrapper.get('[data-testid="read-along-blocked"]').text()).toContain("can't be reached")
    })

    it.each(['no_pair', 'no_epub', 'busy', 'previous_output_not_deletable'] as const)(
      'says nothing about %s before the link, which linking itself resolves',
      (blocked) => {
        const wrapper = mountSection({ mode: 'offer', canToggle: true, state: makeState({ blocked }) })

        expect(wrapper.find('[data-testid="read-along-tag"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
      },
    )

    it.each([
      ['no_target_library', 'Pick a read-along library'],
      ['format_not_allowed', "doesn't allow EPUB"],
    ] as const)('still explains %s before the link', (blocked, expected) => {
      const wrapper = mountSection({ mode: 'offer', canToggle: true, toggleDisabled: true, state: makeState({ blocked }) })

      expect(wrapper.get('[data-testid="read-along-blocked"]').text()).toContain(expected)
    })

    it('hides the toggle from a user who cannot take it', () => {
      const wrapper = mountSection({ mode: 'offer', canToggle: false })

      expect(wrapper.find('[data-testid="read-along-toggle"]').exists()).toBe(false)
    })
  })

  describe('after a failure', () => {
    it('tags it, shows the error and emits retry', async () => {
      const wrapper = mountSection({ state: makeState({ status: 'failed', error: 'Transcription crashed' }) })

      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Failed')
      expect(wrapper.get('[data-testid="read-along-error"]').text()).toBe('Transcription crashed')
      await wrapper.get('[data-testid="read-along-retry"]').trigger('click')
      expect(wrapper.emitted('retry')).toHaveLength(1)
    })

    it('falls back to a generic message', () => {
      const wrapper = mountSection({ state: makeState({ status: 'failed' }) })

      expect(wrapper.get('[data-testid="read-along-error"]').text()).toContain("couldn't finish")
    })
  })

  describe('once ready', () => {
    it('links to the read-along book with its library and both positions', () => {
      const wrapper = mountSection({ state: makeState({ status: 'ready', targetLibraryName: 'Fiction' }), member: makeMember() })

      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Ready')
      const ready = wrapper.get('[data-testid="read-along-ready"]')
      expect(ready.find('a').text()).toBe('Dune (read-along)')
      expect(ready.text()).toContain('Added to Fiction')
      expect(wrapper.get('[data-testid="read-along-progress"]').text()).toBe('42% read · 37% listened')
    })

    it('joins both positions through the catalog, and shows one alone', async () => {
      await withMessages({ book: { detail: { editionLink: { readAlong: { progressBoth: '{read} / {listened}' } } } } }, () => {
        const both = mountSection({ state: makeState({ status: 'ready' }), member: makeMember() })
        expect(both.get('[data-testid="read-along-progress"]').text()).toBe('42% read / 37% listened')
      })

      const readOnly = mountSection({ state: makeState({ status: 'ready' }), member: makeMember({ narrationPercentage: null }) })
      expect(readOnly.get('[data-testid="read-along-progress"]').text()).toBe('42% read')
    })

    it('says the read-along is out of reach when the server hid its book', () => {
      const wrapper = mountSection({ state: makeState({ status: 'ready', hasOutputBook: false }), member: null, existingMatch: makeMatch() })

      expect(sectionState(wrapper)).toBe('outOfReach')
      expect(wrapper.get('[data-testid="read-along-tag"]').text()).toBe('Ready')
      expect(wrapper.get('[data-testid="read-along-body"]').text()).toBe("Added to a library you can't open.")
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
    })

    it('asks before rebuilding, and only emits once confirmed', async () => {
      const wrapper = mountSection({ state: makeState({ status: 'ready' }), member: makeMember() })

      await wrapper.get('[data-testid="read-along-rebuild"]').trigger('click')
      const dialog = wrapper.findComponent(ConfirmDialogStub)
      expect(dialog.props('open')).toBe(true)
      expect(wrapper.emitted('rebuild')).toBeUndefined()

      dialog.vm.$emit('confirm')
      await flushPromises()
      expect(wrapper.emitted('rebuild')).toHaveLength(1)
    })

    it('drops the question once the read-along is no longer ready', async () => {
      const wrapper = mountSection({ state: makeState({ status: 'ready' }), member: makeMember() })
      await wrapper.get('[data-testid="read-along-rebuild"]').trigger('click')

      await wrapper.setProps({ state: makeState({ status: 'building' }) })

      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(false)
    })

    it('hides Rebuild from a caller who cannot delete books', () => {
      const wrapper = mountSection({ state: makeState({ status: 'ready' }), member: makeMember(), canRebuild: false })

      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
    })
  })

  describe('on the read-along book page', () => {
    it('shows the ready state with This book and no actions, whatever the status says', () => {
      const wrapper = mountSection({
        mode: 'readOnly',
        state: makeState({ status: 'none', blocked: 'not_configured' }),
        member: makeMember(),
        isCurrentBook: true,
      })

      expect(sectionState(wrapper)).toBe('ready')
      expect(wrapper.find('[data-testid="read-along-this-book"]').exists()).toBe(true)
      expect(wrapper.find('button').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
    })
  })
})
