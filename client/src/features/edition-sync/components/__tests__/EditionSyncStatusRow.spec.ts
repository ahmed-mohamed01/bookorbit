import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { EditionSyncBookState, EditionSyncIndexState } from '@bookorbit/types'
import EditionSyncStatusRow from '../EditionSyncStatusRow.vue'

function makeState(index: Partial<EditionSyncIndexState> = {}, overrides: Partial<EditionSyncBookState> = {}): EditionSyncBookState {
  return {
    bookId: 1,
    eligible: true,
    editionCount: 2,
    syncOverride: null,
    syncEnabled: true,
    effectiveReason: null,
    wanted: true,
    canRunNow: true,
    canRetry: false,
    hasReadAlong: false,
    hasAudio: true,
    pinned: false,
    runActive: false,
    index: {
      status: 'none',
      stage: null,
      progress: null,
      queuePosition: null,
      nextRunAt: null,
      indexedAt: null,
      indexFileId: null,
      sentences: null,
      matchedSentences: null,
      failedAt: null,
      errorCode: null,
      error: null,
      attemptCount: 0,
      whisperFallback: false,
      workerVersion: null,
      ...index,
    },
    ...overrides,
  }
}

const mountRow = (state: EditionSyncBookState, busy = false) => mount(EditionSyncStatusRow, { props: { state, busy } })

describe('EditionSyncStatusRow', () => {
  it('renders nothing once the index is ready or when sync is off', () => {
    expect(
      mountRow(makeState({ status: 'ready' }))
        .find('[role="status"]')
        .exists(),
    ).toBe(false)
    expect(
      mountRow(makeState({ status: 'queued' }, { syncEnabled: false }))
        .find('[role="status"]')
        .exists(),
    ).toBe(false)
  })

  it('shows the queue position with a run-now icon button', async () => {
    const wrapper = mountRow(makeState({ status: 'queued', queuePosition: 142 }))
    const text = wrapper.get('span.truncate')

    expect(text.text()).toBe('Queued #142')
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Run now')
    expect(button.attributes('title')).toBe('Run now')
    await button.trigger('click')
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('adds when the next run starts to a queued book', () => {
    const wrapper = mountRow(makeState({ status: 'queued', queuePosition: 3, nextRunAt: new Date(2099, 0, 5, 2, 0).toISOString() }))
    expect(wrapper.get('span.truncate').text()).toMatch(/^Queued #3 · /)
  })

  it('says it starts soon instead of the cron time for a pinned book, and hides Run now', () => {
    const wrapper = mountRow(makeState({ status: 'queued', queuePosition: 1, nextRunAt: new Date(2099, 0, 5, 2, 0).toISOString() }, { pinned: true }))
    expect(wrapper.get('span.truncate').text()).toBe('Queued #1 · Starting soon')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('says it starts soon and hides Run now while a run is active', () => {
    const wrapper = mountRow(
      makeState({ status: 'queued', queuePosition: 2, nextRunAt: new Date(2099, 0, 5, 2, 0).toISOString() }, { runActive: true }),
    )
    expect(wrapper.get('span.truncate').text()).toBe('Queued #2 · Starting soon')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('shows the stage and percent while running, without an action', () => {
    const wrapper = mountRow(makeState({ status: 'running', stage: 'aligning', progress: 63 }))

    expect(wrapper.get('span.truncate').text()).toContain('63%')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('failed without a fallback says it could not be indexed and retries', async () => {
    const wrapper = mountRow(makeState({ status: 'failed', whisperFallback: false, error: 'worker exploded' }, { canRetry: true }))
    const text = wrapper.get('span.truncate')

    expect(text.text()).toBe('Could not be indexed')
    expect(text.attributes('title')).toContain('worker exploded')
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Retry')
    await button.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('failed with a ready fallback names it', () => {
    const wrapper = mountRow(makeState({ status: 'failed', whisperFallback: true }, { canRetry: true }))
    expect(wrapper.get('span.truncate').text()).toBe('Could not be indexed · Whisper fallback active')
  })

  it('keeps the live region quiet: no role on the visible text, progress changes do not re-announce', async () => {
    const wrapper = mountRow(makeState({ status: 'running', stage: 'aligning', progress: 43 }))
    expect(wrapper.get('span.truncate').attributes('role')).toBeUndefined()
    const live = wrapper.get('.sr-only[role="status"]')
    const before = live.text()
    expect(before).not.toContain('%')

    await wrapper.setProps({ state: makeState({ status: 'running', stage: 'aligning', progress: 44 }) })
    expect(wrapper.get('.sr-only[role="status"]').text()).toBe(before)
    expect(wrapper.get('span.truncate').text()).toContain('44%')
  })

  it('keeps the text on one line with the full text in the tooltip', () => {
    const wrapper = mountRow(makeState({ status: 'failed', whisperFallback: true }, { canRetry: true }))
    const text = wrapper.get('span.truncate')

    expect(text.classes()).toContain('truncate')
    expect(text.attributes('title')).toBe(text.text())
  })

  it('draws icon-only 26px buttons and disables them while busy', () => {
    const button = mountRow(makeState({ status: 'queued' }), true).get('button')

    expect(button.text()).toBe('')
    expect(button.classes()).toContain('size-6.5')
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('hides the action when the server says it is not allowed', () => {
    expect(
      mountRow(makeState({ status: 'queued' }, { canRunNow: false }))
        .find('button')
        .exists(),
    ).toBe(false)
  })
})
