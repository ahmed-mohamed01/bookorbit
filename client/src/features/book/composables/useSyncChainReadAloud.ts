import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Permission, type BookDetail, type CreateReadAloudJobRequest, type ReadAloudJob } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useAuth } from '@/features/auth/composables/useAuth'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useReadAloud } from '@/features/read-aloud/composables/useReadAloud'
import { useReadAloudPreferences } from '@/features/read-aloud/composables/useReadAloudPreferences'
import { jobErrorMessageKey, resolveReadAloudEntry } from '@/features/read-aloud/lib/read-aloud'
import { defaultReadAloudRequest } from '@/features/book/lib/read-aloud-defaults'
import type { SyncChainReadAloudJob, SyncChainReadAloudSlot } from '@/features/book/lib/sync-chain'

export interface SyncChainReadAloudOptions {
  bookId: number
  book: () => BookDetail
  /** The book has a plain EPUB and audio and no read-along, so the slot can apply. */
  applies: Ref<boolean>
  /** A finished job added a read-along; the host takes the reloaded book. */
  onBookChanged?: (book: BookDetail) => void
}

const SLOT_STATUSES = new Set<ReadAloudJob['status']>(['queued', 'processing', 'awaiting_review', 'failed'])

/** Upstream's read-aloud generator, driven from the Position sync panel's slot. */
export function useSyncChainReadAloud(options: SyncChainReadAloudOptions) {
  const { te } = useI18n()
  const router = useRouter()
  const { user } = useAuth()
  const { hasPermission, isDemoRestrictedAccount } = usePermissions()

  // Same gate as the Files tab: demo accounts are refused by every read-aloud route.
  const permitted = computed(() => hasPermission(Permission.LibraryGenerateReadAloud) && !isDemoRestrictedAccount.value)
  const enabled = computed(() => permitted.value && options.applies.value)

  const readAloud = useReadAloud({
    bookId: computed(() => options.bookId),
    enabled,
    fileIds: computed(() => options.book().files.map((file) => file.id)),
    viewerId: computed(() => user.value?.id ?? null),
    onJobCompleted: () => void reloadBook(),
  })
  const preferences = useReadAloudPreferences()

  const dialogOpen = ref(false)
  const dialogError = ref<string | null>(null)
  const slotError = ref<string | null>(null)

  const entry = computed(() =>
    resolveReadAloudEntry({
      enabled: enabled.value,
      capability: readAloud.capability.value,
      loadFailed: readAloud.loadFailed.value,
      job: readAloud.job.value,
    }),
  )

  const slotJob = computed<SyncChainReadAloudJob | null>(() => {
    const job = readAloud.job.value
    if (!job || job.dismissedAt !== null || !SLOT_STATUSES.has(job.status)) return null
    const retryableUntil = job.retryableUntil ? Date.parse(job.retryableUntil) : Number.NaN
    return {
      status: job.status as SyncChainReadAloudJob['status'],
      stage: job.stage,
      progress: job.progress,
      queuePosition: job.queuePosition,
      stopping: job.cancelRequested,
      canCancel: job.canManage && job.cancellable && job.stage !== 'publishing',
      // Mirrors the job card: Retry resumes from kept work files, which expire.
      canRetry: job.canManage && job.errorCode !== 'review_expired' && retryableUntil > Date.now(),
      errorKey: job.status === 'failed' ? jobErrorMessageKey(job.errorCode, te) : null,
    }
  })

  const slot = computed<SyncChainReadAloudSlot>(() => {
    const action = readAloud.action.value
    return {
      entry: entry.value,
      job: slotJob.value,
      pending: action === null ? null : action === 'create' || action === 'cancel' || action === 'retry' ? action : 'other',
      errorKey: slotError.value ?? readAloud.jobErrorKey.value,
    }
  })

  const busy = computed(() => readAloud.action.value !== null)

  watch(
    () => readAloud.job.value?.id,
    () => {
      slotError.value = null
    },
  )

  async function reloadBook(): Promise<void> {
    try {
      const res = await api(`/api/v1/books/${options.bookId}`)
      if (!res.ok) return
      options.onBookChanged?.((await res.json()) as BookDetail)
    } catch {
      // The book page refreshes on its own file events; a missed reload only delays the new chain.
    }
  }

  function openDialog(): void {
    if (!readAloud.capability.value || entry.value.kind !== 'available') return
    dialogError.value = null
    dialogOpen.value = true
  }

  function closeDialog(): void {
    if (readAloud.action.value !== 'create') dialogOpen.value = false
  }

  async function createFromDialog(input: CreateReadAloudJobRequest): Promise<void> {
    dialogError.value = null
    const result = await readAloud.create(input)
    if (result.ok) {
      dialogOpen.value = false
      slotError.value = null
    } else {
      dialogError.value = result.errorKey
    }
  }

  /** One click: the dialog's own defaults, or the dialog itself when it would need a choice. */
  async function create(): Promise<void> {
    const capability = readAloud.capability.value
    if (!capability || entry.value.kind !== 'available' || busy.value) return
    slotError.value = null
    await preferences.load()
    const input = defaultReadAloudRequest(capability, options.book().language ?? null, preferences.defaultLanguage.value)
    if (!input) {
      openDialog()
      return
    }
    const result = await readAloud.create(input)
    if (!result.ok) slotError.value = result.errorKey
  }

  function cancel(): void {
    void readAloud.cancel()
  }

  function retry(): void {
    void readAloud.retry()
  }

  function review(): void {
    void router.push({ name: 'book-detail', params: { bookId: options.bookId }, query: { tab: 'files', readAloud: 'details' } })
  }

  const dialog = computed(() => ({
    open: dialogOpen.value,
    capability: readAloud.capability.value,
    defaultLanguage: options.book().language ?? null,
    busy: readAloud.action.value === 'create',
    error: dialogError.value,
  }))

  return {
    slot,
    busy,
    dialog,
    create,
    openDialog,
    closeDialog,
    createFromDialog,
    cancel,
    retry,
    review,
  }
}
