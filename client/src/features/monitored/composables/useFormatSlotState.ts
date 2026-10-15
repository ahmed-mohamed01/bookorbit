import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  isGrabbableBookRequestStatus,
  monitoredFormatReleaseDate,
  type BookDetail,
  type BookRequestStatus,
  type MonitorMode,
  type MonitoredFormat,
  type MonitoredWork,
} from '@bookorbit/types'
import { bookFormatEntries } from '@/features/book/lib/book-formats'
import { editionRowAction, ACTIVE_REQUEST_STATUSES, type MonitoredFormatStatus } from '../lib/format-status'
import { slotRequestKind } from '../lib/slot-request'
import { useFormatStatusText } from './useFormatStatusText'
import { useMonitoredDateLabel } from './useMonitoredDateLabel'
import { useMonitoredRequestProgress } from './useMonitoredRequestProgress'
import { parseMonitoredDate } from '../lib/release-date'

export interface FormatSlotInput {
  work: MonitoredWork
  format: MonitoredFormat
  status: MonitoredFormatStatus
  canEdit: boolean
  /** The author monitors this format at all; when not, the per-work switch is not offered either. */
  authorWatches: boolean
  /** The author's mode for this format, which decides what happens without a request. */
  mode?: MonitorMode | null
  book?: BookDetail | null
  bookError?: boolean
  requesting: boolean
  releasesOpen: boolean
}

export type OwnedBody = 'file' | 'error' | 'loading' | 'no-file'

// Mirrors the grab endpoint's claim rule: a live request only takes a hand-picked release while
// it is approved, searching or failed. Settled requests (available, cancelled, rejected) start over.
const RELEASES_BLOCKED_HINT: Partial<Record<BookRequestStatus, string>> = {
  pending: 'monitored.slot.waitingForApproval',
  grabbed: 'monitored.slot.downloadInProgress',
  downloading: 'monitored.slot.downloadInProgress',
  importing: 'monitored.slot.downloadInProgress',
  needs_review: 'monitored.slot.resolveDownloadFirst',
}

/** Everything one format slot decides from its inputs, so the component is layout only. */
export function useFormatSlotState(props: FormatSlotInput, onFiled: (requestId: number) => void) {
  const { t, d } = useI18n()
  const dateLabel = useMonitoredDateLabel('short')
  const { releaseLine } = useFormatStatusText()

  const formatName = computed(() => t(`monitored.formats.${props.format}`))
  const formatLower = computed(() => formatName.value.toLowerCase())
  const owned = computed(() => props.status === 'owned')

  const requestId = computed(() => props.work.requestIds?.[props.format] ?? null)
  const requestStatus = computed(() => props.work.requestStatuses?.[props.format])
  const bookId = computed(() => props.work.matchedBookIds?.[props.format] ?? (owned.value ? props.work.matchedBookId : null) ?? null)
  const bookRoute = computed(() => (bookId.value == null ? null : { name: 'book-detail', params: { bookId: bookId.value } }))
  const requestRoute = computed(() => (requestId.value === null ? null : { name: 'book-request-detail', params: { id: requestId.value } }))

  const watchedRequestId = computed(() => (ACTIVE_REQUEST_STATUSES.has(props.status) ? requestId.value : null))
  useMonitoredRequestProgress(watchedRequestId, { onFiled })

  const edition = computed(() => {
    const book = props.book
    if (!book || !owned.value) return null
    const audio = props.format === 'audiobook'
    return bookFormatEntries(book.files, book.formatPriority).find((entry) => entry.audio === audio) ?? null
  })
  const fileName = computed(() => edition.value?.files[0]?.filename ?? null)
  const filePath = computed(() => edition.value?.files[0]?.absolutePath ?? null)

  const ownedBody = computed<OwnedBody>(() => {
    if (fileName.value) return 'file'
    if (props.bookError) return 'error'
    if (!props.book && bookId.value != null) return 'loading'
    return 'no-file'
  })

  /** Owned formats prefer the library book's full date over a monitored date that only knows the year or month. */
  const releasedOn = computed(() => {
    const { date, precision } = monitoredFormatReleaseDate(props.work, props.format)
    const monitored = parseMonitoredDate(date, precision)
    if (monitored?.precision === 'day') return { yearOnly: false, date: dateLabel(date, precision)! }
    const bookDate = /^\d{4}-\d{2}-\d{2}/.exec(props.book?.publishedDate ?? '')?.[0]
    if (bookDate && (!monitored || monitored.date.getFullYear() === Number(bookDate.slice(0, 4)))) {
      return { yearOnly: false, date: dateLabel(bookDate, 'day')! }
    }
    if (!monitored) return null
    if (monitored.precision === 'year') return { yearOnly: true, date: String(monitored.date.getFullYear()) }
    return { yearOnly: false, date: dateLabel(date, precision)! }
  })
  const availableSince = computed(() => {
    const added = props.book?.addedAt
    if (!added) return null
    return { date: d(new Date(added), { year: 'numeric', month: 'short', day: 'numeric' }) }
  })

  const watching = computed(() => props.work.monitorFormats?.[props.format] !== false && props.status !== 'not_watching')
  const watchTooltip = computed(() => {
    if (!watching.value) return t('monitored.slot.notWatchingHint')
    if (props.status === 'unannounced' || props.status === 'upcoming') {
      if (props.mode === 'auto-upcoming' || props.mode === 'auto-all') return t('monitored.slot.watchingAutoHint')
      if (props.mode === 'notify') return t('monitored.slot.watchingNotifyHint')
    }
    return t('monitored.slot.watchingHint')
  })
  const requestHint = computed(() => (props.status === 'unannounced' ? t('monitored.slot.requestUnannouncedHint') : null))

  const releasesBlockedHint = computed(() => {
    const status = requestStatus.value
    if (!status || isGrabbableBookRequestStatus(status)) return null
    const key = RELEASES_BLOCKED_HINT[status]
    return key ? t(key) : null
  })
  const releasesToggleLabel = computed(() =>
    t(props.releasesOpen ? 'monitored.slot.hideReleasesFormat' : 'monitored.slot.searchReleasesFormat', { format: formatLower.value }),
  )

  const requestKind = computed(() => slotRequestKind(requestStatus.value, props.requesting))
  const action = computed(() => editionRowAction(props.work, props.format, props.status, props.canEdit))
  const canRequest = computed(() => action.value === 'request' || action.value === 'request-once' || action.value === 'retry')

  /** The Request button is on offer: the same rule the slot's button and its ask-for-approval link share. */
  const requestOffered = computed(() => canRequest.value && (requestKind.value === null || requestKind.value === 'failed'))

  const chipLabel = computed(() => releaseLine(props.work, props.format) ?? t('monitored.slot.notAnnounced'))

  const statusLine = computed<{ text: string; tone: string; authorLink: boolean } | null>(() => {
    if (props.status !== 'not_watching') return null
    if (!props.authorWatches) {
      const key = props.format === 'ebook' ? 'monitored.slot.authorNotWatchingEbook' : 'monitored.slot.authorNotWatchingAudiobook'
      return { text: t(key), tone: 'text-muted-foreground', authorLink: true }
    }
    const text = props.canEdit ? t('monitored.slot.notWatchedTurnOn') : t('monitored.slot.notWatched')
    return { text, tone: 'text-muted-foreground', authorLink: false }
  })

  return {
    formatName,
    owned,
    requestRoute,
    bookRoute,
    fileName,
    filePath,
    ownedBody,
    releasedOn,
    availableSince,
    watching,
    watchTooltip,
    requestHint,
    releasesBlockedHint,
    releasesToggleLabel,
    requestKind,
    canRequest,
    requestOffered,
    chipLabel,
    statusLine,
  }
}
