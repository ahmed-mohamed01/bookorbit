import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioConvertJob, AudioConvertPreviewPage, AudioConvertStatus } from '@bookorbit/types'

import * as api from '../../api/audio-convert'
import { useAudioConvert } from '../useAudioConvert'

vi.mock('../../api/audio-convert', () => {
  class AudioConvertHttpError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`)
    }
  }
  return {
    AudioConvertHttpError,
    fetchAudioConvertPreview: vi.fn<(...args: unknown[]) => unknown>(),
    fetchAudioConvertStatus: vi.fn<(...args: unknown[]) => unknown>(),
    runAudioConvert: vi.fn<(...args: unknown[]) => unknown>(),
    stopAudioConvert: vi.fn<(...args: unknown[]) => unknown>(),
    fetchAudioConvertPlan: vi.fn<(...args: unknown[]) => unknown>(),
    skipAudioConvertJob: vi.fn<(...args: unknown[]) => unknown>(),
    convertAudioConvertJobNow: vi.fn<(...args: unknown[]) => unknown>(),
  }
})

const fetchPreview = vi.mocked(api.fetchAudioConvertPreview)
const fetchStatus = vi.mocked(api.fetchAudioConvertStatus)
const runConvert = vi.mocked(api.runAudioConvert)
const stopConvert = vi.mocked(api.stopAudioConvert)
const skipJob = vi.mocked(api.skipAudioConvertJob)

function page(overrides: Partial<AudioConvertPreviewPage> = {}): AudioConvertPreviewPage {
  return { items: [], total: 0, totalByStatus: { can_convert: 3, waiting: 1, converted: 2, cannot: 0 }, ...overrides }
}

function job(id: string, status: AudioConvertJob['status'], bookId = 1): AudioConvertJob {
  return {
    id,
    bookId,
    libraryId: 7,
    title: `Book ${bookId}`,
    trigger: 'manual',
    status,
    stage: status === 'running' ? 'converting' : null,
    progress: status === 'running' ? 40 : null,
    nextStepAt: null,
    codec: 'copy',
    errorCode: null,
    errorMessage: null,
    result: null,
    createdAt: `2026-11-11T10:00:0${id.length}Z`,
    startedAt: null,
    finishedAt: null,
  }
}

function status(
  jobs: AudioConvertJob[],
  active = jobs.filter((j) => ['waiting', 'queued', 'running'].includes(j.status)).length,
): AudioConvertStatus {
  return { jobs, active }
}

let wrapper: ReturnType<typeof mount> | null = null

function setup() {
  let result!: ReturnType<typeof useAudioConvert>
  wrapper = mount(
    defineComponent({
      setup() {
        result = useAudioConvert()
        return () => h('div')
      },
    }),
  )
  return result
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchPreview.mockResolvedValue(page())
  fetchStatus.mockResolvedValue(status([]))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useAudioConvert', () => {
  it('loads the Can convert scope and the per-status totals', async () => {
    const audio = setup()
    audio.selectLibrary(7)
    await audio.loadPreview()

    expect(fetchPreview).toHaveBeenCalledWith(7, 1, 200, 'can_convert', '')
    expect(audio.totalByStatus.value.converted).toBe(2)
    expect(audio.previewReady.value).toBe(true)
  })

  it('reloads with the new status when the scope changes', async () => {
    const audio = setup()
    audio.selectLibrary(7)
    audio.setScope('waiting')
    await flushPromises()

    expect(fetchPreview).toHaveBeenLastCalledWith(7, 1, 200, 'waiting', '')
  })

  it('records an HTTP failure as a code', async () => {
    fetchPreview.mockRejectedValueOnce(new api.AudioConvertHttpError(500))
    const audio = setup()
    audio.selectLibrary(7)
    await audio.loadPreview()

    expect(audio.previewError.value).toEqual({ code: 'http', status: 500 })
  })

  it('polls every two seconds while jobs are active and stops when idle', async () => {
    fetchStatus.mockResolvedValueOnce(status([job('a', 'running')])).mockResolvedValueOnce(status([job('a', 'success')]))
    const audio = setup()
    audio.selectLibrary(7)
    await audio.refreshStatus()
    expect(audio.statusReady.value).toBe(true)
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    // The finished job moves its book to another scope, so the list reloads.
    expect(fetchPreview).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('polls a library with only waiting jobs every thirty seconds', async () => {
    fetchStatus.mockResolvedValue(status([job('w', 'waiting')]))
    const audio = setup()
    audio.selectLibrary(7)
    await audio.refreshStatus()

    await vi.advanceTimersByTimeAsync(29_000)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('counts a cancelled job as finished and reloads the list', async () => {
    fetchStatus.mockResolvedValueOnce(status([job('a', 'queued')])).mockResolvedValueOnce(status([job('a', 'cancelled')]))
    const audio = setup()
    audio.selectLibrary(7)
    await audio.refreshStatus()
    expect(fetchPreview).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchPreview).toHaveBeenCalledTimes(1)
  })

  it('records the search the loaded rows answer to, not the one still being typed', async () => {
    const audio = setup()
    audio.selectLibrary(7)
    audio.setSearch('  expeditionary ')
    expect(audio.appliedSearch.value).toBe('')

    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(fetchPreview).toHaveBeenLastCalledWith(7, 1, 200, 'can_convert', '  expeditionary ')
    expect(audio.appliedSearch.value).toBe('expeditionary')
  })

  it('runs with the narrowed selection and encoder options, then follows the jobs', async () => {
    runConvert.mockResolvedValue({ queued: 2, skipped: 0 })
    fetchStatus.mockResolvedValue(status([job('a', 'running'), job('bb', 'queued', 2)]))
    const audio = setup()
    audio.selectLibrary(7)

    const result = await audio.run({ excludeBookIds: [3] }, { codec: 'aac', bitrate: '64k', channels: 1 })

    expect(runConvert).toHaveBeenCalledWith(7, { excludeBookIds: [3], codec: 'aac', bitrate: '64k', channels: 1 })
    expect(result).toEqual({ queued: 2, skipped: 0 })
    expect(audio.runJobs.value.map((j) => j.id)).toEqual(['a', 'bb'])
  })

  it('keeps waiting jobs off the run bar and hides dismissed finished jobs', async () => {
    fetchStatus.mockResolvedValue(status([job('a', 'success'), job('bb', 'waiting', 2)], 1))
    const audio = setup()
    audio.selectLibrary(7)
    await audio.refreshStatus()

    expect(audio.runJobs.value.map((j) => j.id)).toEqual(['a'])
    audio.dismissFinished()
    expect(audio.runJobs.value).toEqual([])
  })

  it('stops the queue and reports how many were cancelled', async () => {
    stopConvert.mockResolvedValue({ cancelled: 4 })
    const audio = setup()
    audio.selectLibrary(7)

    await expect(audio.stop()).resolves.toBe(4)
    expect(stopConvert).toHaveBeenCalledWith(7)
  })

  it('skips a waiting job and refreshes the list', async () => {
    skipJob.mockResolvedValue(job('w', 'skipped'))
    const audio = setup()
    audio.selectLibrary(7)

    await expect(audio.skipJob(job('w', 'waiting'))).resolves.toBe(true)
    expect(skipJob).toHaveBeenCalledWith('w')
    expect(fetchPreview).toHaveBeenCalled()
  })
})
