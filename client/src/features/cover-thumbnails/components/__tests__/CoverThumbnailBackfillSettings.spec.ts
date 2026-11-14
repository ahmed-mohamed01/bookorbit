import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverThumbnailBackfillState, UpdateCoverThumbnailBackfillPayload } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  fetchState: vi.fn<() => Promise<CoverThumbnailBackfillState>>(),
  update: vi.fn<(payload: UpdateCoverThumbnailBackfillPayload) => Promise<CoverThumbnailBackfillState>>(),
  run: vi.fn<() => Promise<CoverThumbnailBackfillState>>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/cover-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/cover-thumbnails')>()),
  fetchBackfillState: mocks.fetchState,
  updateBackfill: mocks.update,
  runBackfill: mocks.run,
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<(message: string) => void>(), error: mocks.toastError } }))

import CoverThumbnailBackfillSettings from '../CoverThumbnailBackfillSettings.vue'
import { BACKFILL_POLL_MS } from '../../composables/useCoverThumbnailBackfill'

const IDLE: CoverThumbnailBackfillState = {
  enabled: true,
  running: null,
  lastRun: {
    trigger: 'startup',
    outcome: 'completed',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    durationMs: 60_000,
    scanned: 1200,
    missing: 40,
    made: 38,
    unresolved: 2,
  },
}

const RUNNING: CoverThumbnailBackfillState = {
  ...IDLE,
  running: { trigger: 'manual', startedAt: new Date().toISOString(), scanned: 10, missing: 3, made: 2, unresolved: 0 },
}

async function mountSection() {
  const wrapper = mount(CoverThumbnailBackfillSettings)
  await flushPromises()
  return wrapper
}

describe('CoverThumbnailBackfillSettings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchState.mockResolvedValue(IDLE)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the switch and the last run with the covers it could not read', async () => {
    const wrapper = await mountSection()

    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-toggle"]').attributes('aria-checked')).toBe('true')
    const status = wrapper.get('[data-testid="cover-thumbnail-backfill-status"]').text()
    expect(status).toContain('1,200 covers checked, 40 missing, 38 made')
    expect(status).toContain('after start-up')
    expect(status).toContain('2 covers could not be read.')
  })

  it('says when it has never run', async () => {
    mocks.fetchState.mockResolvedValue({ enabled: true, running: null, lastRun: null })
    const wrapper = await mountSection()

    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-status"]').text()).toBe('Not run yet.')
  })

  it('saves the switch as soon as it is flipped', async () => {
    mocks.update.mockResolvedValue({ ...IDLE, enabled: false })
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="cover-thumbnail-backfill-toggle"]').trigger('click')
    await flushPromises()

    expect(mocks.update).toHaveBeenCalledWith({ enabled: false })
    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-toggle"]').attributes('aria-checked')).toBe('false')
  })

  it('starts a run, shows its progress and polls until it finishes', async () => {
    vi.useFakeTimers()
    mocks.run.mockResolvedValue(RUNNING)
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="cover-thumbnail-backfill-run"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-status"]').text()).toContain('10 checked, 2 thumbnails made so far')
    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-run"]').attributes('disabled')).toBeDefined()

    mocks.fetchState.mockResolvedValue(IDLE)
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS)
    await flushPromises()

    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-status"]').text()).toContain('38 made')
    expect(wrapper.get('[data-testid="cover-thumbnail-backfill-run"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('tells the admin when the run could not start', async () => {
    mocks.run.mockRejectedValue(new Error('offline'))
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="cover-thumbnail-backfill-run"]').trigger('click')
    await flushPromises()

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't start the thumbnail run.")
  })
})
