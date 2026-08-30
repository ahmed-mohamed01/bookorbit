import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { AudiobookshelfCleanupResult, AudiobookshelfSettings, AudiobookshelfSyncResult } from '@bookorbit/types'
import AudiobookshelfSyncProgress from '../AudiobookshelfSyncProgress.vue'

function makeSettings(overrides: Partial<AudiobookshelfSettings> = {}): AudiobookshelfSettings {
  return {
    serverUrl: 'https://abs.example.com',
    tokenConfigured: true,
    enabled: true,
    effectiveEnabled: true,
    disabledReason: null,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
    excludedLibraryIds: [],
    pathMappings: [],
    lastSyncedAt: null,
    lastSyncError: null,
    staleCount: 0,
    ...overrides,
  }
}

const syncing = ref(false)
const syncMode = ref<'incremental' | 'full' | null>(null)
const lastResult = ref<AudiobookshelfSyncResult | null>(null)
const syncError = ref<string | null>(null)
const settings = ref<AudiobookshelfSettings | null>(makeSettings())
const cleaningUp = ref(false)
const cleanupError = ref<string | null>(null)
const rescanning = ref(false)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  cleanupStale: vi.fn<(payload?: { includeManuallyUnlinked?: boolean }) => Promise<AudiobookshelfCleanupResult | null>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({ syncing, syncMode, lastResult, error: syncError }),
}))

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({ settings, fetchSettings: mocks.fetchSettings }),
}))

vi.mock('../../composables/useAudiobookshelfLinkedBooks', () => ({
  useAudiobookshelfLinkedBooks: () => ({ cleaningUp, cleanupStale: mocks.cleanupStale, cleanupError, rescanning }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

type Wrapper = ReturnType<typeof mount>

function cleanupButton(wrapper: Wrapper) {
  return wrapper.get('[data-testid="abs-cleanup-stale"]')
}

function includeManualCheckbox(wrapper: Wrapper) {
  return wrapper.get('[data-testid="abs-cleanup-include-manual"] input')
}

async function mountProgress() {
  const wrapper = mount(AudiobookshelfSyncProgress)
  await flushPromises()
  return wrapper
}

describe('AudiobookshelfSyncProgress stale entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncing.value = false
    syncMode.value = null
    lastResult.value = { matched: 1, statusApplied: 2, positionApplied: 3, sessionsApplied: 4, skipped: 0, failed: 0 }
    syncError.value = null
    cleanupError.value = null
    cleaningUp.value = false
    rescanning.value = false
    settings.value = makeSettings()
    mocks.fetchSettings.mockResolvedValue(undefined)
    mocks.cleanupStale.mockResolvedValue({ removed: 4930, staleLinked: 0, staleExcluded: 0, staleManuallyUnlinked: 0, seenItems: 120 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing about stale entries while the count is zero', async () => {
    const wrapper = await mountProgress()

    expect(wrapper.find('[data-testid="abs-stale-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="abs-cleanup-stale"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Last run:')
  })

  it('shows the formatted count next to the last-run line once entries are stale', async () => {
    settings.value = makeSettings({ staleCount: 4930 })
    const wrapper = await mountProgress()

    expect(wrapper.get('[data-testid="abs-stale-count"]').text()).toBe('4,930 stale entries')
    expect(wrapper.get('[data-testid="abs-stale-count"]').classes().join(' ')).toContain('text-destructive')
    expect(cleanupButton(wrapper).text()).toContain('Clean up')
  })

  it('renders the indicator even with no sync result to report', async () => {
    lastResult.value = null
    settings.value = makeSettings({ staleCount: 1 })
    const wrapper = await mountProgress()

    expect(wrapper.get('[data-testid="abs-stale-count"]').text()).toBe('1 stale entry')
    expect(wrapper.text()).not.toContain('Last run:')
  })

  it('requires a second click, then cleans up with the default payload and refreshes the settings and buckets', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    const wrapper = await mountProgress()

    await cleanupButton(wrapper).trigger('click')
    expect(mocks.cleanupStale).not.toHaveBeenCalled()
    expect(cleanupButton(wrapper).text()).toContain('Confirm')

    await cleanupButton(wrapper).trigger('click')
    await flushPromises()

    // cleanupStale is the composable action that reloads all three buckets.
    expect(mocks.cleanupStale).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupStale).toHaveBeenCalledWith({ includeManuallyUnlinked: false })
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Removed 4,930 stale entries')
    expect(wrapper.get('[data-testid="abs-cleanup-summary"]').text()).toBe('Removed 4,930 stale entries')
  })

  it('hides the include-manually-unlinked checkbox until the cleanup is armed', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    const wrapper = await mountProgress()

    expect(wrapper.find('[data-testid="abs-cleanup-include-manual"]').exists()).toBe(false)

    await cleanupButton(wrapper).trigger('click')

    expect(wrapper.get('[data-testid="abs-cleanup-include-manual"]').text()).toContain('Also remove manually unlinked entries')
  })

  it('restarts the 6s arm timeout when the checkbox is ticked', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    const wrapper = await mountProgress()

    vi.useFakeTimers()
    try {
      await cleanupButton(wrapper).trigger('click')
      await vi.advanceTimersByTimeAsync(4000)

      await includeManualCheckbox(wrapper).setValue(true)
      await vi.advanceTimersByTimeAsync(4000)
      // Still armed 8s after the first click: ticking the checkbox at 4s restarted the 6s window.
      expect(cleanupButton(wrapper).text()).toContain('Confirm')

      await vi.advanceTimersByTimeAsync(2100)
      expect(cleanupButton(wrapper).text()).toContain('Clean up')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the includeManuallyUnlinked flag from the checkbox when confirmed', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    const wrapper = await mountProgress()

    await cleanupButton(wrapper).trigger('click')
    await includeManualCheckbox(wrapper).setValue(true)

    await cleanupButton(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.cleanupStale).toHaveBeenCalledWith({ includeManuallyUnlinked: true })
  })

  it('resets the checkbox and hides it once the cleanup completes', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    const wrapper = await mountProgress()

    await cleanupButton(wrapper).trigger('click')
    await includeManualCheckbox(wrapper).setValue(true)

    await cleanupButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="abs-cleanup-include-manual"]').exists()).toBe(false)

    await cleanupButton(wrapper).trigger('click')

    expect((includeManualCheckbox(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('mentions manually unlinked rows kept by the cleanup in the summary', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    mocks.cleanupStale.mockResolvedValue({ removed: 5, staleLinked: 0, staleExcluded: 0, staleManuallyUnlinked: 7, seenItems: 40 })
    const wrapper = await mountProgress()

    await cleanupButton(wrapper).trigger('click')
    await cleanupButton(wrapper).trigger('click')
    await flushPromises()

    expect(toastSuccess).toHaveBeenCalledWith('Removed 5 stale entries, kept 7 manually unlinked')
    expect(wrapper.get('[data-testid="abs-cleanup-summary"]').text()).toBe('Removed 5 stale entries, kept 7 manually unlinked')
  })

  it('reports the failure and leaves the settings untouched when the cleanup fails', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    mocks.cleanupStale.mockResolvedValue(null)
    cleanupError.value = 'Refusing to clean against an empty inventory'
    const wrapper = await mountProgress()

    await cleanupButton(wrapper).trigger('click')
    await cleanupButton(wrapper).trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Refusing to clean against an empty inventory')
    expect(mocks.fetchSettings).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="abs-cleanup-summary"]').exists()).toBe(false)
  })

  it('disables the cleanup while one is running', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    cleaningUp.value = true
    const wrapper = await mountProgress()

    expect(cleanupButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('disables the cleanup while a rescan is in flight', async () => {
    settings.value = makeSettings({ staleCount: 12 })
    rescanning.value = true
    const wrapper = await mountProgress()

    expect(cleanupButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('hides the cleanup row entirely while a sync is running, so the button cannot be clicked', async () => {
    // The stale-count row and the "Sync in progress" indicator are mutually exclusive in this
    // template, so a running sync already keeps the button out of the DOM; the `syncing` disabled
    // condition on the button guards the case regardless.
    settings.value = makeSettings({ staleCount: 12 })
    syncing.value = true
    const wrapper = await mountProgress()

    expect(wrapper.find('[data-testid="abs-cleanup-stale"]').exists()).toBe(false)
  })
})
