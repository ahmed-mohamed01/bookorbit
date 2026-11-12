import { defineComponent, h, reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioConvertJob, AudioConvertPlan, BookDetail } from '@bookorbit/types'

import * as api from '../../api/audio-convert'
import { resetAudioConvertEnabled, useAudioConvertEnabled } from '../../composables/useAudioConvertEnabled'
import AudioConvertBookButton from '../AudioConvertBookButton.vue'

const mocks = vi.hoisted(() => ({
  route: null as unknown as { query: Record<string, string> },
  replace: vi.fn<(to: { query: Record<string, string> }) => Promise<void>>(),
  toast: {
    success: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
  },
}))

vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => false }) }))
vi.mock('../../api/audio-convert', () => {
  class AudioConvertHttpError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`)
    }
  }
  return {
    AudioConvertHttpError,
    fetchAudioConvertEnabled: vi.fn<() => Promise<never>>(() => new Promise<never>(() => {})),
    fetchAudioConvertPlan: vi.fn<(...args: unknown[]) => unknown>(),
    convertBook: vi.fn<(...args: unknown[]) => unknown>(),
    stopBookConvert: vi.fn<(...args: unknown[]) => unknown>(),
  }
})

const fetchPlan = vi.mocked(api.fetchAudioConvertPlan)
const convertBook = vi.mocked(api.convertBook)

const DialogStub = defineComponent({
  name: 'AudioConvertConfirmDialog',
  props: { open: Boolean, defaults: { type: Object, default: null } },
  emits: ['confirm', 'cancel'],
  setup: (props) => () => h('div', { 'data-testid': 'dialog', 'data-open': String(props.open) }),
})

function job(status: AudioConvertJob['status'], errorCode: AudioConvertJob['errorCode'] = null): AudioConvertJob {
  return {
    id: 'j1',
    bookId: 5,
    libraryId: 1,
    title: 'Valkyrie',
    trigger: 'book_page',
    status,
    stage: status === 'running' ? 'converting' : null,
    progress: status === 'running' ? 40 : null,
    nextStepAt: null,
    codec: 'copy',
    errorCode,
    errorMessage: null,
    result: null,
    createdAt: '2026-11-11T10:00:00Z',
    startedAt: null,
    finishedAt: null,
  }
}

function plan(overrides: Partial<AudioConvertPlan> = {}): AudioConvertPlan {
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
    listenersWithProgress: 0,
    bookmarkCount: 0,
    hasReadAlong: false,
    latestJob: null,
    ...overrides,
  }
}

const book = { id: 5, files: [{ id: 1, format: 'mp3', role: 'content' }] } as unknown as BookDetail
let wrapper: VueWrapper | null = null

function mountButton(): VueWrapper {
  wrapper = mount(AudioConvertBookButton, { props: { book }, global: { stubs: { AudioConvertConfirmDialog: DialogStub } } })
  return wrapper
}

function dialogOpen(w: VueWrapper): string | undefined {
  return w.find('[data-testid="dialog"]').attributes('data-open')
}

beforeEach(() => {
  mocks.route = reactive({ query: {} as Record<string, string> })
  mocks.replace.mockImplementation(async (to) => {
    mocks.route.query = to.query
  })
  useAudioConvertEnabled({ autoload: false }).setState(true, { codec: 'aac', bitrate: '64k', channels: 1 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetAudioConvertEnabled()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AudioConvertBookButton', () => {
  it('opens the dialog for ?convert=1 once the plan says it can, and drops the flag', async () => {
    mocks.route.query = { tab: 'files', convert: '1' }
    fetchPlan.mockResolvedValue(plan())
    const w = mountButton()
    expect(dialogOpen(w)).toBe('false')

    await flushPromises()
    expect(mocks.replace).toHaveBeenCalledWith({ query: { tab: 'files' } })
    expect(dialogOpen(w)).toBe('true')
  })

  it('says why instead of opening when the book cannot convert', async () => {
    mocks.route.query = { convert: '1' }
    fetchPlan.mockResolvedValue(plan({ status: 'converted' }))
    const w = mountButton()
    await flushPromises()

    expect(dialogOpen(w)).toBe('false')
    expect(mocks.toast.error).toHaveBeenCalledWith('Already a single M4B.')
    expect(mocks.replace).toHaveBeenCalledWith({ query: {} })
  })

  it('says why when the plan cannot be loaded', async () => {
    mocks.route.query = { convert: '1' }
    fetchPlan.mockRejectedValue(new api.AudioConvertHttpError(500))
    mountButton()
    await flushPromises()

    expect(mocks.toast.error).toHaveBeenCalledWith("Couldn't check this book.")
  })

  it('leaves an ordinary visit alone', async () => {
    fetchPlan.mockResolvedValue(plan())
    const w = mountButton()
    await flushPromises()

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(dialogOpen(w)).toBe('false')
  })

  it('draws at one fixed width before the plan, when ready and while running', async () => {
    let answer!: (value: AudioConvertPlan) => void
    fetchPlan.mockReturnValueOnce(new Promise<AudioConvertPlan>((resolve) => (answer = resolve)))
    const w = mountButton()
    const control = () => w.find('[data-testid="audio-convert-book-control"]')

    expect(w.find('[data-testid="audio-convert-book-button"]').exists()).toBe(true)
    const width = control()
      .classes()
      .filter((c) => c.startsWith('w-'))
    expect(width).toHaveLength(1)

    answer(plan({ latestJob: job('running') }))
    await flushPromises()
    expect(w.find('[data-testid="audio-convert-book-status"]').exists()).toBe(true)
    expect(
      control()
        .classes()
        .filter((c) => c.startsWith('w-')),
    ).toEqual(width)
  })

  it('passes the saved encoder defaults to the dialog and sends only what changed', async () => {
    fetchPlan.mockResolvedValue(plan())
    convertBook.mockResolvedValue(job('queued'))
    const w = mountButton()
    await flushPromises()

    const dialog = w.findComponent(DialogStub)
    expect(dialog.props('defaults')).toEqual({ codec: 'aac', bitrate: '64k', channels: 1 })
    dialog.vm.$emit('confirm', {})
    await flushPromises()
    expect(convertBook).toHaveBeenCalledWith(5, {})
  })

  it('shows a toast when a conversion it watched fails', async () => {
    vi.useFakeTimers()
    fetchPlan.mockResolvedValueOnce(plan({ latestJob: job('running') })).mockResolvedValue(plan({ latestJob: job('failed', 'verify_failed') }))
    mountButton()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.toast.error).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error.mock.calls[0]![0]).toBe('Conversion to M4B failed.')
  })
})
