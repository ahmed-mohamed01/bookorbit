import { vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import type { CreateReadAloudJobRequest, ReadAloudCapability, ReadAloudJob } from '@bookorbit/types'
import type { ReadAloudAction, ReadAloudCreateResult, UseReadAloudOptions } from '@/features/read-aloud/composables/useReadAloud'

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
