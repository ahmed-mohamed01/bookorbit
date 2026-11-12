import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioConvertJob, AudioConvertPlan } from '@bookorbit/types'

import * as api from '../../api/audio-convert'
import { useBookAudioConvert } from '../useBookAudioConvert'

vi.mock('../../api/audio-convert', () => {
  class AudioConvertHttpError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`)
    }
  }
  return {
    AudioConvertHttpError,
    fetchAudioConvertPlan: vi.fn<(...args: unknown[]) => unknown>(),
    convertBook: vi.fn<(...args: unknown[]) => unknown>(),
    stopBookConvert: vi.fn<(...args: unknown[]) => unknown>(),
  }
})

const fetchPlan = vi.mocked(api.fetchAudioConvertPlan)
const convertBook = vi.mocked(api.convertBook)
const stopBook = vi.mocked(api.stopBookConvert)

function job(status: AudioConvertJob['status']): AudioConvertJob {
  return {
    id: 'j1',
    bookId: 5,
    libraryId: 1,
    title: 'Valkyrie',
    trigger: 'book_page',
    status,
    stage: status === 'running' ? 'converting' : null,
    progress: status === 'running' ? 50 : null,
    nextStepAt: null,
    codec: 'copy',
    errorCode: null,
    errorMessage: null,
    result: null,
    createdAt: '2026-11-11T10:00:00Z',
    startedAt: null,
    finishedAt: null,
  }
}

function plan(latestJob: AudioConvertJob | null = null): AudioConvertPlan {
  return {
    bookId: 5,
    status: 'can_convert',
    reason: null,
    files: [],
    outputName: 'Valkyrie.m4b',
    autoCodec: 'copy',
    autoCodecReason: 'all_match',
    totalBytes: 100,
    totalDurationMs: 1000,
    chapterCount: 3,
    chapterSource: 'stored',
    hasCover: true,
    listenersWithProgress: 1,
    bookmarkCount: 0,
    hasReadAlong: false,
    latestJob,
  }
}

let wrapper: ReturnType<typeof mount> | null = null

function setup(onConverted = vi.fn<(job: AudioConvertJob) => void>(), onFailed = vi.fn<(job: AudioConvertJob) => void>()) {
  let result!: ReturnType<typeof useBookAudioConvert>
  wrapper = mount(
    defineComponent({
      setup() {
        result = useBookAudioConvert(ref(5), { onConverted, onFailed })
        return () => h('div')
      },
    }),
  )
  return { convert: result, onConverted, onFailed }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useBookAudioConvert', () => {
  it('loads the plan without polling when nothing is running', async () => {
    fetchPlan.mockResolvedValue(plan())
    const { convert } = setup()
    await convert.load()

    expect(convert.plan.value?.outputName).toBe('Valkyrie.m4b')
    expect(convert.active.value).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchPlan).toHaveBeenCalledTimes(1)
  })

  it('starts a conversion, polls the job, and reports success once', async () => {
    fetchPlan
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(plan(job('running')))
      .mockResolvedValueOnce(plan(job('success')))
    convertBook.mockResolvedValue(job('queued'))
    const { convert, onConverted } = setup()
    await convert.load()

    await expect(convert.convert({ codec: 'auto', bitrate: '128k', channels: null })).resolves.toBe(true)
    expect(convertBook).toHaveBeenCalledWith(5, { codec: 'auto', bitrate: '128k', channels: null })
    expect(convert.active.value).toBe(true)

    await vi.advanceTimersByTimeAsync(2000)
    expect(convert.job.value?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(2000)
    expect(convert.job.value?.status).toBe('success')
    expect(onConverted).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchPlan).toHaveBeenCalledTimes(3)
  })

  it('polls a waiting job every thirty seconds, not every two', async () => {
    fetchPlan.mockResolvedValue(plan(job('waiting')))
    const { convert } = setup()
    await convert.load()
    expect(convert.active.value).toBe(true)

    await vi.advanceTimersByTimeAsync(29_000)
    expect(fetchPlan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchPlan).toHaveBeenCalledTimes(2)
  })

  it('switches to the fast poll once a waiting job is queued', async () => {
    fetchPlan.mockResolvedValueOnce(plan(job('waiting'))).mockResolvedValue(plan(job('queued')))
    const { convert } = setup()
    await convert.load()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(convert.job.value?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchPlan).toHaveBeenCalledTimes(3)
  })

  it('reports a watched job that fails, once', async () => {
    const failed = { ...job('failed'), errorCode: 'ffmpeg_failed' as const }
    fetchPlan.mockResolvedValueOnce(plan(job('running'))).mockResolvedValue(plan(failed))
    const { convert, onConverted, onFailed } = setup()
    await convert.load()

    await vi.advanceTimersByTimeAsync(2000)
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledWith(failed)
    expect(onConverted).not.toHaveBeenCalled()
    await convert.load()
    expect(onFailed).toHaveBeenCalledTimes(1)
  })

  it('does not report an old failure found on first load', async () => {
    fetchPlan.mockResolvedValue(plan(job('failed')))
    const { convert, onFailed } = setup()
    await convert.load()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('sends only the encoder fields it is given', async () => {
    fetchPlan.mockResolvedValue(plan())
    convertBook.mockResolvedValue(job('queued'))
    const { convert } = setup()
    await convert.load()

    await convert.convert({})
    expect(convertBook).toHaveBeenCalledWith(5, {})
  })

  it('keeps the HTTP status when starting fails', async () => {
    fetchPlan.mockResolvedValue(plan())
    convertBook.mockRejectedValue(new api.AudioConvertHttpError(409))
    const { convert } = setup()
    await convert.load()

    await expect(convert.convert({ codec: 'copy', bitrate: '128k', channels: null })).resolves.toBe(false)
    expect(convert.actionError.value).toBe(409)
  })

  it('stops the job and reloads the plan', async () => {
    fetchPlan.mockResolvedValueOnce(plan(job('queued'))).mockResolvedValueOnce(plan(job('cancelled')))
    stopBook.mockResolvedValue({ cancelled: true })
    const { convert } = setup()
    await convert.load()

    await expect(convert.stop()).resolves.toBe(true)
    expect(stopBook).toHaveBeenCalledWith(5)
    expect(convert.active.value).toBe(false)
  })
})
