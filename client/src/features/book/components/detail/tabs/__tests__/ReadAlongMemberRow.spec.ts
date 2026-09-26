import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { EditionLinkMember, StorytellerExistingMatch } from '@bookorbit/types'
import type { ReadAlongRowState } from '../../../../composables/useReadAlong'
import ReadAlongMemberRow from '../ReadAlongMemberRow.vue'

// The rebuild is the one action here that deletes a library book, so it asks first. The dialog is
// stubbed so a test can answer it without driving a portalled overlay.
const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialogStub',
  props: { open: { type: Boolean, default: false } },
  emits: ['confirm', 'cancel'],
  template: '<div />',
})

async function confirmRebuild(wrapper: { findComponent: (c: unknown) => { vm: { $emit: (e: string) => void } } }) {
  wrapper.findComponent(ConfirmDialogStub).vm.$emit('confirm')
  await flushPromises()
}

const stubs = {
  RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' },
}

function makeState(overrides: Partial<ReadAlongRowState> = {}): ReadAlongRowState {
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
    progress: { percentage: 42, updatedAt: '2026-09-01T00:00:00.000Z' },
    narrationPercentage: 37,
    ...overrides,
  }
}

function makeMatch(overrides: Partial<StorytellerExistingMatch> = {}): StorytellerExistingMatch {
  return { uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94, ...overrides }
}

interface RowProps {
  state: ReadAlongRowState
  member: EditionLinkMember | null
  canGenerate: boolean
  canRebuild: boolean
  existingMatch: StorytellerExistingMatch | null
  isCurrentBook: boolean
}

function mountRow(props: Partial<RowProps> = {}) {
  return mount(ReadAlongMemberRow, {
    props: {
      state: makeState(),
      member: null,
      canGenerate: true,
      canRebuild: true,
      existingMatch: null,
      isCurrentBook: false,
      ...props,
    },
    global: { stubs: { ...stubs, ConfirmDialog: ConfirmDialogStub } },
  })
}

describe('ReadAlongMemberRow', () => {
  describe('with no read-along yet', () => {
    it('offers generation and emits generate', async () => {
      const wrapper = mountRow()

      const button = wrapper.find('[data-testid="read-along-generate"]')
      expect(button.text()).toContain('Generate read-along')
      expect(button.attributes('disabled')).toBeUndefined()

      await button.trigger('click')
      expect(wrapper.emitted('generate')).toHaveLength(1)
    })

    it('shows a muted line instead of any action without the upload permission', () => {
      const wrapper = mountRow({ canGenerate: false })

      expect(wrapper.find('[data-testid="read-along-none"]').text()).toContain('No read-along yet')
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })

    it('offers an aligned Storyteller book for import, and emits its uuid', async () => {
      const wrapper = mountRow({ existingMatch: makeMatch() })

      const button = wrapper.find('[data-testid="read-along-import"]')
      expect(button.text()).toContain('Forward the Foundation')

      await button.trigger('click')
      expect(wrapper.emitted('importExisting')).toEqual([['uuid-1']])
    })

    it('ignores an unaligned Storyteller match, which still has to be processed', () => {
      const wrapper = mountRow({ existingMatch: makeMatch({ aligned: false }) })

      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
    })
  })

  describe('block reasons', () => {
    it('disables generation and explains a configuration block', () => {
      const wrapper = mountRow({ state: makeState({ blocked: 'not_configured' }) })

      expect(wrapper.find('[data-testid="read-along-generate"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain("isn't configured")
    })

    it('keeps the button enabled for a busy server so it can be retried', () => {
      const wrapper = mountRow({ state: makeState({ blocked: 'busy' }) })

      expect(wrapper.find('[data-testid="read-along-generate"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('busy')
    })

    it.each([
      ['no_pair', 'Link an ebook'],
      ['no_epub', 'no EPUB'],
      ['no_audio', 'no audio'],
      ['no_target_library', 'read-along library'],
      ['target_not_allowed', "don't have access"],
      ['format_not_allowed', "doesn't allow EPUB"],
      ['unreachable', "can't be reached"],
    ] as const)('explains the %s block', (blocked, expected) => {
      const wrapper = mountRow({ state: makeState({ blocked }) })

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain(expected)
    })

    it('shows the rejection of a rebuild on a ready row, and stops offering it', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready', blocked: 'previous_output_not_deletable' }), member: makeMember() })

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('permission to delete books')
      expect(wrapper.find('[data-testid="read-along-rebuild"]').attributes('disabled')).toBeDefined()
    })

    it('shows the rejection of a retry on a failed row, and stops offering it', () => {
      const wrapper = mountRow({ state: makeState({ status: 'failed', blocked: 'not_configured', error: 'provider timeout' }) })

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain("isn't configured")
      expect(wrapper.find('[data-testid="read-along-retry"]').attributes('disabled')).toBeDefined()
    })

    it('keeps retry clickable while Storyteller is merely busy, and says why it was refused', () => {
      const wrapper = mountRow({ state: makeState({ status: 'failed', blocked: 'busy', error: 'provider timeout' }) })

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('busy')
      expect(wrapper.find('[data-testid="read-along-retry"]').attributes('disabled')).toBeUndefined()
    })

    it('surfaces a block that appears while a build is on screen', () => {
      const wrapper = mountRow({ state: makeState({ status: 'building', phase: 'wait', blocked: 'no_target_library' }) })

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('read-along library')
    })

    it('leaves the block message out for a viewer who cannot generate anything', () => {
      const wrapper = mountRow({ state: makeState({ blocked: 'not_configured' }), canGenerate: false })

      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
    })
  })

  describe('keeping the Storyteller copy', () => {
    it('prices the copy in its tooltip and emits the choice', async () => {
      const wrapper = mountRow({
        state: makeState({
          status: 'none',
          transport: 'api-transfer',
          remoteCopyBytes: { epub: 1_200_000, audio: 183_000_000, readAlong: null },
          keepRemoteCopy: true,
        }),
      })

      const toggle = wrapper.get('[data-testid="read-along-keep-copy"]')
      expect(toggle.attributes('aria-checked')).toBe('true')
      expect(wrapper.text()).toContain('Keep Storyteller copy')

      // The tooltip body only exists once it is opened, so the hint is read from the sr-only copy
      // that the trigger always renders.
      const hint = wrapper.get('[data-testid="read-along-keep-copy-hint"]').attributes('aria-label') ?? ''
      expect(hint).toContain('1.1 MB')
      expect(hint).toContain('174.5 MB')
      expect(hint).toContain('never deleted')

      await toggle.trigger('click')

      expect(wrapper.emitted('update:keepRemoteCopy')?.[0]).toEqual([false])
    })

    // Over shared paths Storyteller reads the library's own files and writes the read-along into the
    // library folder, so its book points at nothing BookOrbit may delete. A toggle whose two
    // positions produce the same outcome is the UI claiming a choice that does not exist.
    it('offers no keep-copy choice when Storyteller holds no copy of its own', () => {
      const wrapper = mountRow({ state: makeState({ remoteCopyReclaimable: false }) })

      expect(wrapper.find('[data-testid="read-along-keep-copy"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-keep-copy-hint"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-keep-copy-moot"]').text()).toContain('keeps no copy to remove')
    })

    it('reflects an instance default of "do not keep" rather than forcing the box on', () => {
      const wrapper = mountRow({ state: makeState({ keepRemoteCopy: false }) })

      expect(wrapper.get('[data-testid="read-along-keep-copy"]').attributes('aria-checked')).toBe('false')
    })

    it('words the unbuilt read-along instead of pricing it at "-" before the first build', () => {
      const wrapper = mountRow({
        state: makeState({ transport: 'api-transfer', remoteCopyBytes: { epub: 1_200_000, audio: 183_000_000, readAlong: null } }),
      })

      const hint = wrapper.get('[data-testid="read-along-keep-copy-hint"]').attributes('aria-label') ?? ''
      expect(hint).toContain('1.1 MB')
      expect(hint).toContain('174.5 MB')
      expect(hint).toContain('plus the read-along')
      expect(hint).not.toContain('(-)')
    })

    it('drops every figure when no size is known at all', () => {
      const wrapper = mountRow({ state: makeState({ remoteCopyBytes: { epub: null, audio: null, readAlong: null } }) })

      const hint = wrapper.get('[data-testid="read-along-keep-copy-hint"]').attributes('aria-label') ?? ''
      expect(hint).toContain('copies of your files')
      expect(hint).toContain('never deleted')
      expect(hint).not.toContain('-)')
    })

    // Under shared paths Storyteller reads the library's own files in place and never holds a copy of
    // them, so pricing them here would offer space that keeping or deleting cannot change - and
    // nothing in this feature ever deletes a file in the user's library.
    it("never prices the library's own files when Storyteller reads them in place", () => {
      const wrapper = mountRow({
        state: makeState({
          transport: 'shared-paths',
          remoteCopyReclaimable: false,
          remoteCopyBytes: { epub: 1_200_000, audio: 183_000_000, readAlong: null },
        }),
      })

      // Shared paths means there is no copy at all, so the control and its hint are replaced.
      expect(wrapper.find('[data-testid="read-along-keep-copy-hint"]').exists()).toBe(false)
      const moot = wrapper.get('[data-testid="read-along-keep-copy-moot"]').text()
      expect(moot).not.toContain('174.5 MB')
      expect(moot).toContain('keeps no copy to remove')
    })

    // Before a build there is no transport to read, so the hint says the cost depends rather than
    // promising a total that only one of the two routes would ever reach.
    it('says the cost depends while no build has chosen a transport', () => {
      const wrapper = mountRow({
        state: makeState({ transport: null, remoteCopyBytes: { epub: 1_200_000, audio: 183_000_000, readAlong: null } }),
      })

      const hint = wrapper.get('[data-testid="read-along-keep-copy-hint"]').attributes('aria-label') ?? ''
      expect(hint).toContain('if it cannot read them in place')
      expect(hint).toContain('never deleted')
    })

    it('describes the choice to a keyboard or screen-reader user through a focusable trigger', () => {
      const wrapper = mountRow({
        state: makeState({ transport: 'api-transfer', remoteCopyBytes: { epub: 1_200_000, audio: 183_000_000, readAlong: null } }),
      })

      const trigger = wrapper.get('[data-testid="read-along-keep-copy-hint"]')
      expect(trigger.element.tagName).toBe('BUTTON')
      expect(trigger.attributes('aria-label')).toContain('174.5 MB')
    })
  })

  describe('while building', () => {
    it('names the Storyteller stage in words and shows its progress', () => {
      const wrapper = mountRow({
        state: makeState({ status: 'building', phase: 'wait', remoteTask: 'TRANSCRIBE_CHAPTERS', remoteProgress: 0.37 }),
      })

      expect(wrapper.find('[data-testid="read-along-building"]').text()).toContain('Storyteller is aligning')
      expect(wrapper.find('[data-testid="read-along-stage"]').text()).toBe('Step 2 of 3: Transcribing tracks')
      expect(wrapper.text()).not.toContain('TRANSCRIBE_CHAPTERS')
      expect(wrapper.find('[data-testid="read-along-progress"]').text()).toBe('37%')
      expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('37')
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })

    it('words an unknown stage rather than printing the constant', () => {
      const wrapper = mountRow({ state: makeState({ status: 'building', phase: 'wait', remoteTask: 'POLISH_OVERLAYS' }) })

      expect(wrapper.find('[data-testid="read-along-stage"]').text()).toBe('Polish overlays')
      expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    })

    it('drops the Storyteller stage once BookOrbit takes over to collect the file', () => {
      const wrapper = mountRow({
        state: makeState({ status: 'building', phase: 'collect', remoteTask: 'SYNC_CHAPTERS', remoteProgress: 1 }),
      })

      expect(wrapper.find('[data-testid="read-along-building"]').text()).toContain('Collecting the read-along')
      expect(wrapper.find('[data-testid="read-along-stage"]').exists()).toBe(false)
      expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    })

    it('falls back to a generic building line when no phase is reported yet', () => {
      const wrapper = mountRow({ state: makeState({ status: 'building' }) })

      expect(wrapper.find('[data-testid="read-along-building"]').text()).toContain('Building the read-along')
    })

    // Background detail, not status: the card is mostly a progress bar, so how the files reached
    // Storyteller belongs behind the info affordance the row already has.
    it.each([
      ['shared-paths', 'reading the files where they are'],
      ['api-transfer', 'uploaded to Storyteller'],
    ] as const)('explains in the tooltip whether the files are uploaded or read in place over %s', (transport, expected) => {
      const wrapper = mountRow({ state: makeState({ status: 'building', phase: 'process', transport }) })

      // Not a line of its own any more; the info trigger's accessible name is what carries it.
      expect(wrapper.find('[data-testid="read-along-transport"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-destination"]').attributes('aria-label') ?? '').toContain(expected)
    })

    it('says nothing about the transport until the build has one', () => {
      const wrapper = mountRow({ state: makeState({ status: 'building', phase: 'prepare' }) })

      const hint = wrapper.get('[data-testid="read-along-destination"]').attributes('aria-label') ?? ''
      expect(hint).not.toContain('uploaded to Storyteller')
      expect(hint).not.toContain('reading the files where they are')
    })
  })

  describe('once ready but out of reach', () => {
    // What the server sends when the read-along landed in a library this user cannot open: the build
    // is ready, and its book is masked. A deleted output is downgraded to 'none' instead.
    it('says the read-along exists and offers nothing that would be refused', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready', hasOutputBook: false }), member: null })

      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').text()).toContain('already generated')
      expect(wrapper.text()).toContain("don't have access to")
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-none"]').exists()).toBe(false)
    })

    it('still offers nothing when an aligned Storyteller match could be imported', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready', hasOutputBook: false }), member: null, existingMatch: makeMatch() })

      expect(wrapper.find('[data-testid="read-along-import"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').exists()).toBe(true)
    })

    it('keeps the ready row instead when the book exists but has not been loaded into the link yet', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready', hasOutputBook: true }), member: null })

      expect(wrapper.find('[data-testid="read-along-ready-pending"]').text()).toContain('Read-along ready')
      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })
  })

  describe('after a failure', () => {
    it('shows the error and emits retry', async () => {
      const wrapper = mountRow({ state: makeState({ status: 'failed', error: 'provider timeout' }) })

      expect(wrapper.find('[data-testid="read-along-failed"]').text()).toContain('Read-along build failed')
      expect(wrapper.text()).toContain('provider timeout')

      await wrapper.find('[data-testid="read-along-retry"]').trigger('click')
      expect(wrapper.emitted('retry')).toHaveLength(1)
    })

    it('falls back to a generic message when the server reported no error text', () => {
      const wrapper = mountRow({ state: makeState({ status: 'failed' }) })

      expect(wrapper.text()).toContain("couldn't finish this read-along")
    })

    it('hides the retry action without the upload permission', () => {
      const wrapper = mountRow({ state: makeState({ status: 'failed', error: 'boom' }), canGenerate: false })

      expect(wrapper.find('[data-testid="read-along-retry"]').exists()).toBe(false)
    })
  })

  describe('once ready', () => {
    it('links to the read-along book and shows both reading positions', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember() })

      const routerLink = wrapper.find('a')
      expect(routerLink.text()).toBe('Dune (read-along)')
      expect(routerLink.attributes('href')).toContain('book-detail')
      expect(routerLink.attributes('href')).toContain('30')
      expect(wrapper.find('[data-testid="read-along-progress"]').text()).toContain('42% read')
      expect(wrapper.find('[data-testid="read-along-progress"]').text()).toContain('37% listened')
    })

    it('omits the narration figure when the read-along has never been narrated', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember({ narrationPercentage: null }) })

      expect(wrapper.find('[data-testid="read-along-progress"]').text()).toContain('42% read')
      expect(wrapper.find('[data-testid="read-along-progress"]').text()).not.toContain('Narration')
    })

    it('marks the row when the read-along is the book being viewed', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember(), isCurrentBook: true })

      expect(wrapper.text()).toContain('This book')
    })

    // A rebuild deletes the read-along it replaces, and that is a book in the user's own library.
    // Nothing else in this feature removes one, so the click alone must not be enough.
    it('does not emit rebuild until the deletion is confirmed', async () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember() })
      // The stub renders whether or not it opened, so the open prop is the only thing that proves
      // the click reached the gate rather than going straight through it.
      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(false)

      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(true)
      expect(wrapper.emitted('rebuild')).toBeUndefined()

      await confirmRebuild(wrapper)
      expect(wrapper.emitted('rebuild')).toHaveLength(1)
      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(false)
    })

    // A poll can retire the output while the question is on screen, and the dialog names the book it
    // promises to delete.
    it('closes the confirmation when the row stops being ready', async () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember() })
      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(true)

      await wrapper.setProps({ state: makeState({ status: 'none' }), member: null })

      expect(wrapper.findComponent(ConfirmDialogStub).props('open')).toBe(false)
    })

    it('abandons the rebuild when the confirmation is dismissed', async () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember() })

      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      wrapper.findComponent(ConfirmDialogStub).vm.$emit('cancel')
      await flushPromises()

      expect(wrapper.emitted('rebuild')).toBeUndefined()
    })

    it('emits rebuild from the rebuild action, and hides it without the upload permission', async () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember() })

      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      await confirmRebuild(wrapper)
      expect(wrapper.emitted('rebuild')).toHaveLength(1)

      const readOnly = mountRow({ state: makeState({ status: 'ready' }), member: makeMember(), canGenerate: false })
      expect(readOnly.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
    })

    // The server refuses a forced rebuild from a caller who cannot delete books, so offering the
    // button would spend a click to be told the read-along already exists - which the row is already
    // showing.
    it('hides the rebuild action from a caller who cannot delete books', () => {
      const wrapper = mountRow({ state: makeState({ status: 'ready' }), member: makeMember(), canRebuild: false })

      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })

    // `previous_output_not_deletable` is what the server answers such a caller, and turning the
    // generate action into a rebuild there would hand back the button the permission check removed.
    it('does not relabel the action as a rebuild when the caller cannot delete books', () => {
      const wrapper = mountRow({ state: makeState({ blocked: 'previous_output_not_deletable' }), canRebuild: false })

      expect(wrapper.text()).not.toContain('Rebuild read-along')
    })
  })
})
