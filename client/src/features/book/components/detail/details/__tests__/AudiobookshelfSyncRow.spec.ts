import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { AudiobookshelfBookState, AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive, BookDetail } from '@bookorbit/types'
import { absLink, absLive } from '@/features/book/lib/__tests__/sync-fixtures'
import AudiobookshelfSyncRow from '../AudiobookshelfSyncRow.vue'

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn<(permission: string) => boolean>(),
  toastError: vi.fn<(message: string) => void>(),
  audioBookIds: [] as (number | null)[],
}))

vi.mock('vue-sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn<(message: string) => void>() } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: mocks.hasPermission }) }))

const abs = {
  link: ref<AudiobookshelfBookSyncLink | null>(null),
  live: ref<AudiobookshelfBookSyncLive | null>(null),
  checking: ref(false),
  configured: ref(true),
  loadConfigured: vi.fn<() => Promise<void>>(),
  refreshLive: vi.fn<() => Promise<void>>(),
  applyLive: vi.fn<(live: AudiobookshelfBookSyncLive) => void>(),
  reload: vi.fn<() => Promise<void>>(),
}

vi.mock('@/features/book/composables/useAudiobookshelfSyncLink', async () => {
  const { watch } = await import('vue')
  return {
    useAudiobookshelfSyncLink: (audioBookId: import('vue').Ref<number | null>) => {
      watch(audioBookId, (id) => mocks.audioBookIds.push(id), { immediate: true })
      return abs
    },
  }
})

const actions = {
  busy: ref<string | null>(null),
  actionError: ref<string | null>(null),
  clearError: vi.fn<() => void>(),
  reconcile: vi.fn<(direction: string) => Promise<boolean>>().mockResolvedValue(true),
  retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  resume: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  pause: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  confirm: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  change: vi.fn<(item: AudiobookshelfBookState) => Promise<boolean>>().mockResolvedValue(true),
  search: {
    query: ref(''),
    results: ref<AudiobookshelfBookState[]>([]),
    searching: ref(false),
    searchError: ref(false),
    hasSearched: ref(false),
    setQuery: vi.fn<(value: string) => void>(),
    reset: vi.fn<() => void>(),
  },
}
vi.mock('@/features/book/composables/useAudiobookshelfSyncActions', () => ({ useAudiobookshelfSyncActions: () => actions }))

function file(id: number, format: string) {
  return { id, format, role: 'content', filename: `book.${format}`, absolutePath: `/books/book.${format}`, sizeBytes: 100 }
}

function book(formats: string[] = ['m4b', 'epub']): BookDetail {
  return { id: 12, files: formats.map((format, index) => file(index + 1, format)), formatPriority: [] } as unknown as BookDetail
}

const ConfirmDialogStub = {
  name: 'ConfirmDialog',
  props: ['open', 'title', 'description', 'confirmLabel', 'busy', 'destructive'],
  emits: ['confirm', 'cancel'],
  template: '<div v-if="open" data-testid="confirm-dialog">{{ title }}</div>',
}

async function mountRow(target: BookDetail = book()) {
  const wrapper = mount(AudiobookshelfSyncRow, {
    attachTo: document.body,
    props: { book: target },
    global: { stubs: { ConfirmDialog: ConfirmDialogStub, RouterLink: { props: ['to'], template: '<a data-testid="router-link"><slot /></a>' } } },
  })
  await flushPromises()
  return wrapper
}

function dropdown(): HTMLElement | null {
  return document.body.querySelector('[data-testid="sync-issue-content"]')
}

describe('AudiobookshelfSyncRow', () => {
  beforeEach(() => {
    mocks.hasPermission.mockReset().mockReturnValue(true)
    mocks.toastError.mockReset()
    mocks.audioBookIds.length = 0
    abs.link.value = null
    abs.live.value = null
    abs.configured.value = true
    abs.loadConfigured.mockReset().mockResolvedValue(undefined)
    actions.busy.value = null
    actions.actionError.value = null
    for (const fn of [actions.reconcile, actions.retry, actions.resume, actions.pause, actions.confirm, actions.change]) fn.mockClear()
    actions.search.setQuery.mockClear()
    actions.search.reset.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('stays hidden for a book without audio, without the permission or with Audiobookshelf off', async () => {
    expect((await mountRow(book(['epub']))).find('[data-testid="abs-sync-row"]').exists()).toBe(false)
    expect(abs.loadConfigured).not.toHaveBeenCalled()

    mocks.hasPermission.mockReturnValue(false)
    expect((await mountRow()).find('[data-testid="abs-sync-row"]').exists()).toBe(false)

    mocks.hasPermission.mockReturnValue(true)
    abs.configured.value = false
    expect((await mountRow()).find('[data-testid="abs-sync-row"]').exists()).toBe(false)
    expect(mocks.audioBookIds.every((id) => id === null)).toBe(true)
  })

  it('reads the match only once Audiobookshelf is known to be configured', async () => {
    const wrapper = await mountRow()
    expect(abs.loadConfigured).toHaveBeenCalledTimes(1)
    expect(mocks.audioBookIds).toEqual([null, 12])
    expect(wrapper.get('[data-testid="abs-sync-row"]').text()).toContain('Audiobookshelf sync')
  })

  it('shows Not linked and opens the match search when the switch is turned on', async () => {
    const wrapper = await mountRow()
    expect(wrapper.get('[data-testid="abs-sync-status"]').text()).toBe('Not linked')
    expect(wrapper.find('[data-testid="sync-issue-trigger"]').exists()).toBe(false)

    await wrapper.get('[data-testid="abs-sync-toggle"]').trigger('click')
    await flushPromises()
    expect(dropdown()?.textContent).toContain('Pick the Audiobookshelf item')
    expect(dropdown()?.querySelector('[data-testid="abs-match-search"]')).not.toBeNull()
    expect(actions.search.setQuery).toHaveBeenCalledWith('')
  })

  it('links the picked item and closes the search', async () => {
    const item = { absLibraryItemId: 'li_9', absTitle: 'Other' } as AudiobookshelfBookState
    actions.search.results.value = [item]
    const wrapper = await mountRow()
    await wrapper.get('[data-testid="abs-sync-status"]').trigger('click')
    await flushPromises()
    dropdown()?.querySelector<HTMLButtonElement>('[data-testid="abs-match-search-result"]')?.click()
    await flushPromises()

    expect(actions.change).toHaveBeenCalledWith(item)
    expect(dropdown()).toBeNull()
    actions.search.results.value = []
  })

  it('names a healthy direction and opens the item details with Change match', async () => {
    abs.link.value = absLink()
    abs.live.value = absLive()
    const wrapper = await mountRow()
    expect(wrapper.get('[data-testid="abs-sync-status"]').text()).toBe('Two-way')
    expect(wrapper.get('[data-testid="abs-sync-status"]').classes()).toContain('text-muted-foreground')

    await wrapper.get('[data-testid="abs-sync-status"]').trigger('click')
    await flushPromises()
    const item = dropdown()?.querySelector('[data-testid="abs-sync-item"]')
    expect(item?.textContent).toContain('He Who Fights')
    expect(item?.textContent).toContain('Fiction library')
    expect(item?.querySelector('[data-testid="abs-sync-item-progress"]')?.textContent).toContain('52% listened')
    expect(item?.querySelector('a')?.getAttribute('href')).toBe('https://abs.example/item/li_1')

    dropdown()?.querySelector<HTMLButtonElement>('[data-action="change"]')?.click()
    await flushPromises()
    expect(dropdown()?.querySelector('[data-testid="abs-match-search"]')).not.toBeNull()
  })

  it('shows a one-way match as One-way with its direction on hover', async () => {
    abs.link.value = absLink({ direction: 'from_abs' })
    abs.live.value = absLive()
    const wrapper = await mountRow()
    const status = wrapper.get('[data-testid="abs-sync-status"]')
    expect(status.text()).toBe('One-way')
    expect(status.attributes('title')).toBe('From Audiobookshelf')
  })

  it('asks before pausing a syncing match', async () => {
    abs.link.value = absLink()
    const wrapper = await mountRow()
    await wrapper.get('[data-testid="abs-sync-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').text()).toBe('Stop syncing with Audiobookshelf?')
    expect(actions.pause).not.toHaveBeenCalled()

    wrapper.findComponent(ConfirmDialogStub).vm.$emit('confirm')
    await flushPromises()
    expect(actions.pause).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('resumes a paused match from the switch', async () => {
    abs.link.value = absLink({ syncing: false, pausedReason: 'excluded' })
    const wrapper = await mountRow()
    expect(wrapper.get('[data-testid="abs-sync-status"]').text()).toBe('Paused')
    await wrapper.get('[data-testid="abs-sync-toggle"]').trigger('click')
    expect(actions.resume).toHaveBeenCalledTimes(1)
  })

  it('puts a divergence behind a warning icon whose fixes reconcile', async () => {
    abs.link.value = absLink()
    abs.live.value = absLive({
      status: 'diverged',
      progress: { percentage: 94, isFinished: false, lastUpdate: 1 },
      local: { percentage: 91, capturedAt: 'x' },
    })
    const wrapper = await mountRow()
    const trigger = wrapper.get('[data-testid="sync-issue-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('Audiobookshelf is ahead')
    expect(wrapper.find('[data-testid="abs-sync-status"]').exists()).toBe(false)

    await trigger.trigger('click')
    await flushPromises()
    expect(dropdown()?.textContent).toContain('Audiobookshelf 94%, BookOrbit 91%.')
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="push"]')?.click()
    await flushPromises()
    expect(actions.reconcile).toHaveBeenCalledWith('push')
    expect(dropdown()).toBeNull()
  })

  it('offers a retry and the settings link when Audiobookshelf cannot be reached', async () => {
    abs.link.value = absLink()
    abs.live.value = absLive({ status: 'unreachable' })
    const wrapper = await mountRow()
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    expect(dropdown()?.querySelector('[data-testid="abs-sync-settings"]')).not.toBeNull()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click()
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('locks the switch when position sync is off in the settings', async () => {
    abs.link.value = absLink({ syncing: false, pausedReason: 'position_sync_off' })
    const wrapper = await mountRow()
    expect(wrapper.get('[data-testid="abs-sync-toggle"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="sync-issue-trigger"]').attributes('aria-label')).toBe('Off in settings')
  })

  it('shows a failed action as a toast', async () => {
    abs.link.value = absLink()
    await mountRow()
    actions.actionError.value = 'Could not update the position. Try again.'
    await flushPromises()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not update the position. Try again.')
  })

  it('loads the configured flag once the book gains audio after mount', async () => {
    const wrapper = await mountRow(book(['epub']))
    expect(abs.loadConfigured).not.toHaveBeenCalled()
    await wrapper.setProps({ book: book(['m4b', 'epub']) })
    await flushPromises()
    expect(abs.loadConfigured).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="abs-sync-row"]').exists()).toBe(true)
    await wrapper.setProps({ book: book(['mp3', 'epub']) })
    await flushPromises()
    expect(abs.loadConfigured).toHaveBeenCalledTimes(1)
  })

  it('confirms a match that needs review from the switch, and Change swaps in the search', async () => {
    abs.link.value = absLink({ syncing: false, pausedReason: 'needs_review' })
    const wrapper = await mountRow()
    const trigger = wrapper.get('[data-testid="sync-issue-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('Needs review')

    await wrapper.get('[data-testid="abs-sync-toggle"]').trigger('click')
    await flushPromises()
    expect(actions.confirm).toHaveBeenCalledTimes(1)

    await trigger.trigger('click')
    await flushPromises()
    expect(dropdown()?.querySelector('[data-testid="abs-match-search"]')).toBeNull()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="change"]')?.click()
    await flushPromises()
    expect(dropdown()?.querySelector('[data-testid="abs-match-search"]')).not.toBeNull()
    expect(actions.search.setQuery).toHaveBeenCalledWith('')
    expect(wrapper.get('[data-testid="sync-issue-trigger"]').attributes('aria-label')).toBe('Needs review')
  })

  it('shows receiving as plain text whose details offer Use now', async () => {
    abs.link.value = absLink()
    abs.live.value = absLive({ status: 'receiving' })
    const wrapper = await mountRow()
    expect(wrapper.get('[data-testid="abs-sync-status"]').text()).toBe('Receiving')
    expect(wrapper.find('[data-testid="sync-issue-trigger"]').exists()).toBe(false)

    await wrapper.get('[data-testid="abs-sync-status"]').trigger('click')
    await flushPromises()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="pull"]')?.click()
    await flushPromises()
    expect(actions.reconcile).toHaveBeenCalledWith('pull')
    expect(dropdown()).toBeNull()
  })

  it('links to the Audiobookshelf settings when position sync is off there', async () => {
    abs.link.value = absLink({ syncing: false, pausedReason: 'position_sync_off' })
    const wrapper = await mountRow()
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    const link = dropdown()?.querySelector('[data-testid="abs-sync-settings"]')
    expect(link?.textContent).toContain('Audiobookshelf settings')
  })

  it.each([
    ['the problem text', () => absLive({ status: 'unreachable' }), '[data-testid="abs-sync-status-text"]'],
    ['the status button', () => absLive(), '[data-testid="abs-sync-status"]'],
  ])('points the switch at %s that names the status', async (_, live, selector) => {
    abs.link.value = absLink()
    abs.live.value = live()
    const wrapper = await mountRow()
    const id = wrapper.get(selector).attributes('id')
    expect(id).toBeTruthy()
    expect(wrapper.get('[data-testid="abs-sync-toggle"]').attributes('aria-describedby')).toBe(id)
  })
})
