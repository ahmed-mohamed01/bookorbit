import { vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import type {
  AlignmentStatus,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  CreateReadAloudJobRequest,
  ReadAloudCapability,
  ReadAloudJob,
} from '@bookorbit/types'
import type { ReadAloudAction, ReadAloudCreateResult, UseReadAloudOptions } from '@/features/read-aloud/composables/useReadAloud'

/** Fakes for the composables useSyncChainPanel drives; `calls` records the order of the requests they stand for. */
export const calls: string[] = []

export function createAlignmentState() {
  return {
    status: ref<AlignmentStatus>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    stale: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildError: ref<string | null>(null),
    buildBlocked: ref<'disabled' | 'unavailable' | 'busy' | null>(null),
    fetchStatus: vi.fn<(id: number) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignmentStatus')
    }),
    build: vi.fn<(id: number, force?: boolean) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignment')
    }),
    cancel: vi.fn<(id: number) => Promise<boolean>>().mockImplementation(async () => {
      calls.push('cancelAlignment')
      return true
    }),
  }
}

export function createAbsState() {
  return {
    link: ref<AudiobookshelfBookSyncLink | null>(null),
    live: ref<AudiobookshelfBookSyncLive | null>(null),
    checking: ref(false),
    configured: ref(true),
    loadConfigured: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refreshLive: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    applyLive: vi.fn<(live: AudiobookshelfBookSyncLive) => void>(),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    audioBookIds: [] as (number | null)[],
  }
}

/** Upstream's `useReadAloud`, with the options it was built with kept for inspection. */
export function createReadAloudState() {
  return {
    capability: shallowRef<ReadAloudCapability | null>(null),
    job: shallowRef<ReadAloudJob | null>(null),
    loading: ref(false),
    loadFailed: ref(false),
    failedChecks: ref(0),
    action: ref<ReadAloudAction | null>(null),
    jobErrorKey: ref<string | null>(null),
    create: vi.fn<(input: CreateReadAloudJobRequest) => Promise<ReadAloudCreateResult>>().mockResolvedValue({ ok: true }),
    cancel: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    retry: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    publish: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    dismiss: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resync: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refreshJob: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearJobError: vi.fn<() => void>(),
    options: null as UseReadAloudOptions | null,
  }
}

export function createReadAloudPreferencesState() {
  return {
    defaultLanguage: ref<string | null>(null),
    loaded: ref(false),
    saving: ref(false),
    load: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveDefaultLanguage: vi.fn<(code: string) => Promise<boolean>>().mockResolvedValue(true),
  }
}
