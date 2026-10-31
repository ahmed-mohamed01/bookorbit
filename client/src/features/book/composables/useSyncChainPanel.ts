import { computed, ref, watch, type UnwrapNestedRefs } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  Permission,
  type AlignmentStatus,
  type AudiobookshelfBookState,
  type BookDetail,
  type ReadAloudProgressSync,
  type ReadAloudProgressSyncMode,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import type { EditionProgress } from '@/features/book/components/detail/details/BookEditionsCard.vue'
import { bookFormatEntries, formatKeyName, type BookFormatEntry } from '@/features/book/lib/book-formats'
import { commonStem, splitExtension } from '@/features/book/lib/filename-stem'
import {
  buildSyncChain,
  initialViewMode,
  type ChainActionId,
  type ChainConnectorRow,
  type ChainMessage,
  type ChainViewMode,
  type ConnectorKey,
  type EditionKey,
  type SyncChainAlignment,
  type SyncChainEdition,
  type SyncChainSnapshot,
} from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { useAudiobookshelfSyncActions } from './useAudiobookshelfSyncActions'
import { useAudiobookshelfSyncLink } from './useAudiobookshelfSyncLink'
import { useReadingAlignment } from './useReadingAlignment'
import { useSyncChainReadAloud } from './useSyncChainReadAloud'

const CHAIN = 'book.detail.editionLink.chain.'

const ALIGNMENT_RUNNING = new Set<AlignmentStatus>(['pending', 'building'])

export type SyncChainDialogKind = 'pauseAbs'

export interface SyncChainDialog {
  kind: SyncChainDialogKind
  title: ChainMessage
  description: ChainMessage
  confirmLabel: ChainMessage
}

export interface SyncChainPanelOptions {
  /** Each edition's progress, keyed like `bookFormatEntries`; the book page already loads it. */
  progress?: () => readonly EditionProgress[]
  onSaved?: (book: BookDetail) => void
}

type FileEntry = BookFormatEntry<BookDetail['files'][number]>

function fileBase(file: BookDetail['files'][number]): string {
  const name = file.filename ?? file.absolutePath.split(/[\\/]/).pop() ?? ''
  return splitExtension(name).base
}

function entryTitle(entry: FileEntry): string | null {
  const bases = entry.files.map(fileBase).filter((base) => base.length > 0)
  if (bases.length > 1) return commonStem(bases) || bases[0]!
  return bases[0] ?? null
}

export function useSyncChainPanel(book: () => BookDetail, options: SyncChainPanelOptions = {}) {
  const { t } = useI18n()
  const bookId = book().id

  const { hasPermission } = usePermissions()
  const canAlign = computed(() => hasPermission(Permission.LibraryEditMetadata))
  const canSyncAbs = computed(() => hasPermission(Permission.AudiobookshelfSync))

  /* The book's own files. */

  const entries = computed(() => bookFormatEntries(book().files, book().formatPriority))

  function edition(match: (entry: FileEntry) => boolean): SyncChainEdition | null {
    const entry = entries.value.find(match)
    if (!entry) return null
    const progress = options.progress?.().find((row) => row.key === entry.key)
    return {
      title: entryTitle(entry),
      formatName: formatKeyName(entry.key),
      fileCount: entry.files.length,
      sizeBytes: entry.sizeBytes,
      progress: progress?.percentage ?? null,
    }
  }

  const ebook = computed(() => edition((entry) => !entry.audio && !entry.readAlong && entry.key === 'epub'))
  const audiobook = computed(() => edition((entry) => entry.audio))
  const readAlong = computed(() => edition((entry) => entry.readAlong))
  // Upstream's read-aloud sync owns text and audio once the book has a read-along.
  const usesWhisper = computed(() => ebook.value !== null && audiobook.value !== null && readAlong.value === null)

  /* Whisper alignment of the plain EPUB with the audio, both in this book. */

  const alignment = useReadingAlignment()
  const alignmentRunning = computed(() => ALIGNMENT_RUNNING.has(alignment.status.value) || alignment.mutating.value)

  const alignmentSnapshot = computed<SyncChainAlignment>(() => ({
    status: alignment.status.value,
    stale: alignment.stale.value,
    builtAt: alignment.builtAt.value,
    samplesDone: alignment.samplesDone.value,
    samplesTotal: alignment.samplesTotal.value,
    buildBlocked: alignment.buildBlocked.value,
    buildError: alignment.buildError.value,
    running: alignmentRunning.value,
  }))

  async function buildAlignment(force: boolean): Promise<void> {
    await alignment.build(bookId, force)
    if (alignment.error.value) toast.error(t('book.detail.readingAlignment.buildFailed'))
  }

  // Only a cancel in flight locks the cancel button: a build in flight is exactly what it stops.
  const cancelling = ref(false)

  async function cancelAlignment(): Promise<void> {
    cancelling.value = true
    try {
      if (!(await alignment.cancel(bookId))) toast.error(t('book.detail.editionLink.syncCancelKeptRunning'))
    } finally {
      cancelling.value = false
    }
  }

  function fetchAlignmentStatus(): Promise<unknown> {
    if (!usesWhisper.value) return Promise.resolve()
    return Promise.allSettled([alignment.fetchStatus(bookId)])
  }

  /* Upstream's read-aloud sync between the read-along EPUB and the audio. */

  const readAloudSync = ref<ReadAloudProgressSync>(book().readAloudSync)
  const readAloudSaving = ref(false)

  watch(
    () => book().readAloudSync,
    (value) => {
      readAloudSync.value = value
    },
  )

  function formatDuration(seconds: number | null | undefined): string {
    if (seconds == null) return '-'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return hours > 0 ? t('book.detail.details.durationHm', { hours, minutes }) : t('book.detail.details.durationM', { minutes })
  }

  async function setReadAloudSyncMode(mode: ReadAloudProgressSyncMode): Promise<void> {
    if (readAloudSaving.value || readAloudSync.value.mode === mode) return
    readAloudSaving.value = true
    try {
      const res = await api(`/api/v1/books/${bookId}/read-aloud-sync`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) throw new Error('Failed to update read-aloud sync')
      const updated = (await res.json()) as BookDetail
      readAloudSync.value = updated.readAloudSync
      options.onSaved?.(updated)
    } catch {
      toast.error(t('book.detail.details.readAloudSync.saveFailed'))
    } finally {
      readAloudSaving.value = false
    }
  }

  /* Upstream's read-aloud generator, for a book with a plain EPUB and audio but no read-along yet. */

  const readAloud = useSyncChainReadAloud({
    bookId,
    book,
    applies: usesWhisper,
    onBookChanged: (updated) => options.onSaved?.(updated),
  })

  /* Audiobookshelf matches the audiobook, which is this book whenever it holds audio. */

  const absAudioBookId = computed(() => (audiobook.value ? bookId : null))
  const abs = useAudiobookshelfSyncLink(absAudioBookId)
  const absActions = useAudiobookshelfSyncActions(abs, () => absAudioBookId.value)

  /* Eligibility: two of the book's own sides to sync, or Audiobookshelf for its audio. The read-aloud slot needs EPUB and audio, so it never adds a case. */

  const syncableSides = computed(() => [ebook.value, audiobook.value, readAlong.value].filter((side) => side !== null).length)
  const absApplies = computed(() => audiobook.value !== null && canSyncAbs.value && abs.configured.value)
  const isEligible = computed(() => syncableSides.value >= 2 || absApplies.value)

  /* The chain. */

  const snapshot = computed<SyncChainSnapshot>(() => ({
    bookId,
    coverVersion: book().coverVersion,
    ebook: ebook.value,
    audiobook: audiobook.value,
    readAlong: readAlong.value,
    readAloudSlot: readAloud.slot.value,
    alignment: alignmentSnapshot.value,
    readAloud: {
      sync: readAloudSync.value,
      audioDuration: formatDuration(readAloudSync.value.audioDurationSeconds),
      overlayDuration: formatDuration(readAloudSync.value.overlayDurationSeconds),
    },
    abs: canSyncAbs.value ? { configured: abs.configured.value, link: abs.link.value, live: abs.live.value, checking: abs.checking.value } : null,
    can: { align: canAlign.value },
  }))

  const chain = computed(() => buildSyncChain(snapshot.value))

  /* View mode. */

  const viewMode = ref<ChainViewMode | null>(null)
  let pendingView: { availableHeight: number; force: ChainViewMode | undefined } = { availableHeight: Number.POSITIVE_INFINITY, force: undefined }
  let openId = 0
  let promotedThisOpen = false

  /** Records the space the trigger leaves; the view itself is decided once the open has loaded, so the panel never switches under the reader. */
  function prepareView(availableHeight: number, force?: ChainViewMode): void {
    pendingView = { availableHeight, force }
  }

  function decideView(): void {
    viewMode.value = pendingView.force ?? initialViewMode(chain.value, pendingView.availableHeight)
  }

  // A failure that lands after the view was decided still has to be seen, but a view the reader chose is never overridden.
  watch(
    () => chain.value.needsAttention,
    (needsAttention) => {
      if (!needsAttention || promotedThisOpen || viewMode.value !== 'compact') return
      promotedThisOpen = true
      viewMode.value = 'modify'
    },
  )

  function setViewMode(mode: ChainViewMode): void {
    promotedThisOpen = true
    viewMode.value = mode
  }

  /* Audiobookshelf match search, in place of its slot. */

  const changing = ref<EditionKey | null>(null)

  function closeSearch(): void {
    changing.value = null
    absActions.search.reset()
  }

  async function pickAbsItem(item: AudiobookshelfBookState): Promise<void> {
    if (await absActions.change(item)) changing.value = null
  }

  function openAbsSearch(): void {
    changing.value = 'abs'
    absActions.search.reset()
    absActions.search.setQuery('')
  }

  /* Confirms. */

  const dialogKind = ref<SyncChainDialogKind | null>(null)
  const dialogBusy = ref(false)

  const dialog = computed<SyncChainDialog | null>(() => {
    if (dialogKind.value !== 'pauseAbs') return null
    return {
      kind: 'pauseAbs',
      title: { key: `${CHAIN}confirm.pauseAbs.title` },
      description: { key: `${CHAIN}confirm.pauseAbs.description` },
      confirmLabel: { key: `${CHAIN}confirm.pauseAbs.confirm` },
    }
  })

  function cancelDialog(): void {
    if (dialogBusy.value) return
    dialogKind.value = null
  }

  async function confirmDialog(): Promise<void> {
    if (!dialogKind.value || dialogBusy.value) return
    dialogBusy.value = true
    try {
      await absActions.pause()
    } finally {
      dialogBusy.value = false
      dialogKind.value = null
    }
  }

  /* Actions. */

  const ACTIONS: Record<ChainActionId, () => void> = {
    cancelAlignment: () => void cancelAlignment(),
    retryAlignment: () => void buildAlignment(false),
    alignNow: () => void buildAlignment(false),
    rebuildAlignment: () => void buildAlignment(true),
    enableReadAloudSync: () => void setReadAloudSyncMode('auto'),
    disableReadAloudSync: () => void setReadAloudSyncMode('disabled'),
    createReadAloud: () => void readAloud.create(),
    modifyReadAloud: readAloud.openDialog,
    cancelReadAloud: readAloud.cancel,
    retryReadAloud: readAloud.retry,
    reviewReadAloud: readAloud.review,
    change: openAbsSearch,
    retryAbs: () => void absActions.retry(),
    absPush: () => void absActions.reconcile('push'),
    absPull: () => void absActions.reconcile('pull'),
    confirmAbs: () => void absActions.confirm(),
    resumeAbs: () => void absActions.resume(),
    pauseAbs: () => (dialogKind.value = 'pauseAbs'),
  }

  function runAction(id: ChainActionId): void {
    ACTIONS[id]()
  }

  // Switches are derived from the data, so a cancelled confirm leaves them where they were by itself.
  function switchConnector(key: ConnectorKey, next: boolean): void {
    const row = chain.value.rows.find((candidate): candidate is ChainConnectorRow => candidate.kind === 'connector' && candidate.key === key)
    const toggle = row?.switch
    if (!toggle || toggle.disabled) return
    const id = next ? toggle.onAction : toggle.offAction
    if (id) runAction(id)
  }

  const busy = computed(
    () => alignment.mutating.value || absActions.busy.value !== null || dialogBusy.value || readAloudSaving.value || readAloud.busy.value,
  )

  /* Trigger. */

  const TRIGGER_TONE_CLASS = { success: 'text-success', info: 'text-info', warning: 'text-warning', destructive: 'text-destructive', muted: '' }

  const triggerIconClass = computed(() => TRIGGER_TONE_CLASS[chain.value.header.tone])
  const triggerTooltip = computed(() => t(`${CHAIN}tooltip`, { status: chainText(chain.value.header.label, t) }))

  /* Loading. */

  // Read up front so the trigger's hover title reflects the real state before the popover is opened,
  // and so an audio-only book learns whether Audiobookshelf gives it a trigger at all.
  async function loadInitial(): Promise<void> {
    await Promise.allSettled([fetchAlignmentStatus(), loadAbsConfigured()])
  }

  // Audiobookshelf only ever links the audiobook, so a book without one never needs its settings.
  function loadAbsConfigured(): Promise<void> {
    return audiobook.value && canSyncAbs.value ? abs.loadConfigured() : Promise.resolve()
  }

  async function handleOpen(): Promise<void> {
    const current = ++openId
    closeSearch()
    dialogKind.value = null
    absActions.clearError()
    viewMode.value = null
    promotedThisOpen = false
    const absConfigured = loadAbsConfigured()
    const statuses = fetchAlignmentStatus()
    void abs.refreshLive()
    await Promise.allSettled([statuses, absConfigured])
    if (current === openId) decideView()
  }

  return {
    isEligible,
    triggerIconClass,
    triggerTooltip,
    chain,
    abs,
    absActions,
    viewMode,
    setViewMode,
    prepareView,
    changing,
    search: {
      pickAbsItem,
      close: closeSearch,
    },
    runAction,
    switchConnector,
    dialog,
    dialogBusy,
    confirmDialog,
    cancelDialog,
    busy,
    cancelling,
    readAloudDialog: readAloud.dialog,
    closeReadAloudDialog: readAloud.closeDialog,
    createReadAloudFromDialog: readAloud.createFromDialog,
    loadInitial,
    handleOpen,
  }
}

export type SyncChainPanelState = ReturnType<typeof useSyncChainPanel>
export type SyncChainPanelView = UnwrapNestedRefs<SyncChainPanelState>
