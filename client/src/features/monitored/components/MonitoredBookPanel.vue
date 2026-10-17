<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff, Star, X } from '@lucide/vue'
import {
  MONITORED_FORMATS,
  type BookDetail,
  type MonitorMode,
  type MonitoredFormat,
  type MonitoredMarkKind,
  type MonitoredWork,
  type ReleaseCandidateItem,
} from '@bookorbit/types'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import BookCoverPlaceholder from '@/features/book/components/BookCoverPlaceholder.vue'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { formatNumber } from '@/i18n/formatters'
import { useBookDetail } from '@/features/book/composables/useBookDetail'
import { useSafeHtml } from '@/features/book/composables/useSafeHtml'
import { useMonitoredReleases } from '../composables/useMonitoredReleases'
import { useReleaseRows } from '../composables/useReleaseRows'
import { useWorkReleaseDates } from '../composables/useWorkReleaseDates'
import { useWorkMatch, type MonitoredMatchAnswer } from '../composables/useWorkMatch'
import { normalizeSeriesName } from '../lib/grouping'
import { subtitleRepeatsSeries } from '../lib/subtitle'
import { workFormatStatus, type MonitoredFormatStatus } from '../lib/format-status'
import MonitoredFormatSlot from './MonitoredFormatSlot.vue'
import MonitoredMarkAsMenu from './MonitoredMarkAsMenu.vue'
import MonitoredSlotReleases from './MonitoredSlotReleases.vue'
import MonitoredSynopsis from './MonitoredSynopsis.vue'
import MonitoredTagPills from './MonitoredTagPills.vue'
import MonitoredVisibilityBanner from './MonitoredVisibilityBanner.vue'

const props = withDefaults(
  defineProps<{
    work: MonitoredWork | null
    authorName: string
    canManage: boolean
    monitoredFormats?: MonitoredFormat[]
    /** The monitored author this work belongs to, so the byline can link to its page. */
    authorId?: string | null
    /** False on that author's own page, where the byline would link to where the reader already is. */
    linkAuthor?: boolean
    /** The author's mode per format: whether a release is grabbed or only announced. */
    formatModes?: Partial<Record<MonitoredFormat, MonitorMode>>
    /** The monitored author's genres, shown as tags when no owned library book has any. */
    authorGenres?: string[]
    authorPaused?: boolean
    /** The page behind the panel can resume the author without leaving. */
    canResumeAuthor?: boolean
    /** When the author's files were last checked; null before the first check. */
    checkedAt?: string | null
    checking?: boolean
    open: boolean
  }>(),
  { linkAuthor: true },
)
const emit = defineEmits<{
  'update:open': [value: boolean]
  request: [work: MonitoredWork, format: MonitoredFormat, autoDownload: boolean]
  grabbed: [work: MonitoredWork, format: MonitoredFormat, requestId: number]
  filed: [work: MonitoredWork, requestId: number]
  'toggle-monitor': [work: MonitoredWork, format: MonitoredFormat, value: boolean]
  'toggle-hidden': [work: MonitoredWork, value: boolean]
  /** Drops the owner's hidden or kept choice, so the verdict decides again. */
  'set-automatic': [work: MonitoredWork]
  /** Marks the work as a kind other than a plain book, which moves it to Review. */
  'set-kind': [work: MonitoredWork, kind: MonitoredMarkKind]
  /** Runs the author refresh that re-checks every format's files on disk. */
  'check-library': []
  'resume-author': []
  /** A release date change answers with the whole work, for every list showing it to read from. */
  'work-updated': [work: MonitoredWork]
}>()

const SERIES_IN_HEADER = 2
const visibleSeries = computed(() => seriesLinks.value.slice(0, SERIES_IN_HEADER))
const moreSeries = computed(() => seriesLinks.value.slice(SERIES_IN_HEADER).map((series) => series.label))
const showSubtitle = computed(() => !!props.work?.subtitle && !subtitleRepeatsSeries(props.work.subtitle, props.work.seriesMemberships ?? []))

const { t } = useI18n()

const imageFailed = ref(false)

const workIdRef = computed<string | null>(() => props.work?.id ?? null)
const coverUrl = computed(() => toMonitoredCoverUrl(props.work?.coverUrl))
const placeholderAuthors = computed(() => (props.authorName ? [props.authorName] : null))
const authorRoute = computed(() => (props.authorId ? { name: 'monitored-author', params: { id: props.authorId } } : null))
const bylineRoute = computed(() => (props.linkAuthor === false ? null : authorRoute.value))

const seriesLinks = computed(() => {
  const libraryIds = new Map<string, number>()
  for (const book of [detail.value, secondaryDetail.value]) {
    for (const membership of book?.seriesMemberships ?? []) libraryIds.set(normalizeSeriesName(membership.seriesName), membership.seriesId)
    if (book?.seriesId != null && book.seriesName) libraryIds.set(normalizeSeriesName(book.seriesName), book.seriesId)
  }
  return (props.work?.seriesMemberships ?? []).map((membership) => {
    const libraryId = libraryIds.get(normalizeSeriesName(membership.name))
    const to =
      libraryId != null
        ? { name: 'series-detail', params: { seriesId: libraryId } }
        : bylineRoute.value
          ? { ...bylineRoute.value, query: { group: 'series' } }
          : null
    return { label: membership.index != null ? `${membership.name} #${membership.index}` : membership.name, to }
  })
})

const safeDescription = useSafeHtml(() => props.work?.description)

// The ebook and the audiobook are separate library rows; matchedBookIds carries each format's row.
const { detail, error: detailError, notFound: detailNotFound, fetch: fetchDetail } = useBookDetail()
const { detail: secondaryDetail, error: secondaryError, notFound: secondaryNotFound, fetch: fetchSecondaryDetail } = useBookDetail()
const secondaryBookId = computed(() => {
  const ids = props.work?.matchedBookIds
  if (!ids) return null
  const primary = props.work?.matchedBookId
  return [ids.ebook, ids.audiobook].find((id) => id != null && id !== primary) ?? null
})
const ratingLines = computed(() =>
  (props.work?.ratings ?? []).map((rating) => ({
    source: rating.source,
    name: t(`monitored.panel.ratings.sources.${rating.source}`),
    average: formatNumber(rating.average, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    count:
      rating.count == null
        ? null
        : t('monitored.panel.ratings.count', {
            count: rating.count,
            formatted: formatNumber(rating.count, { notation: 'compact', maximumFractionDigits: 1 }),
          }),
  })),
)
const workTags = computed(() => {
  for (const book of [detail.value, secondaryDetail.value]) {
    if (!book) continue
    const own = book.genres.length ? book.genres : book.tags
    if (own.length) return own
  }
  return props.authorGenres ?? []
})
const loadedBooks = computed<Array<BookDetail | null>>(() => [detail.value, secondaryDetail.value])

function bookFor(id: number | null | undefined): BookDetail | null {
  if (id == null) return null
  return loadedBooks.value.find((book) => book?.id === id) ?? null
}

function bookIdForFormat(format: MonitoredFormat): number | null {
  const work = props.work
  if (!work) return null
  return work.matchedBookIds?.[format] ?? (statuses.value[format] === 'owned' ? work.matchedBookId : null) ?? null
}

/** A lookup that failed, or found no book, says so; a book still on its way does not. */
function bookFailedFor(id: number | null): boolean {
  if (id == null) return false
  if (id === props.work?.matchedBookId) return detailError.value !== null || detailNotFound.value
  if (id === secondaryBookId.value) return secondaryError.value !== null || secondaryNotFound.value
  return false
}

function handleRetryBook(format: MonitoredFormat) {
  const id = bookIdForFormat(format)
  if (id == null) return
  if (id === props.work?.matchedBookId) void fetchDetail(id)
  else if (id === secondaryBookId.value) void fetchSecondaryDetail(id)
}

const ebookReleases = useMonitoredReleases(workIdRef, 'ebook')
const audioReleases = useMonitoredReleases(workIdRef, 'audiobook')
const releaseDates = useWorkReleaseDates(workIdRef)
const workMatch = useWorkMatch(workIdRef)
/** Only one lookup is open at a time, and a saved date closes the one that saved it. */
const openDatesFormat = ref<MonitoredFormat | null>(null)
const openReleases = ref<Record<MonitoredFormat, boolean>>({ ebook: false, audiobook: false })
/** A card the reader folded or unfolded by hand; the rest fold while the other format's results are open. */
const manualCollapsed = ref<Partial<Record<MonitoredFormat, boolean>>>({})

function isCollapsed(format: MonitoredFormat): boolean {
  const manual = manualCollapsed.value[format]
  if (manual !== undefined) return manual
  // Folding gives the other card's results room; a results card folded by hand has nothing to make room for.
  const other: MonitoredFormat = format === 'ebook' ? 'audiobook' : 'ebook'
  return openReleases.value[other] && manualCollapsed.value[other] !== true
}

function handleToggleCollapsed(format: MonitoredFormat) {
  manualCollapsed.value = { ...manualCollapsed.value, [format]: !isCollapsed(format) }
}

function releasesFor(format: MonitoredFormat) {
  return format === 'audiobook' ? audioReleases : ebookReleases
}

/** Requests this panel already reported as filed; the slots watch their own request each. */
const announcedFiled = new Set<number>()

function handleSlotFiled(requestId: number) {
  if (!props.work || announcedFiled.has(requestId)) return
  announcedFiled.add(requestId)
  emit('filed', props.work, requestId)
}

function isFormatMonitored(format: MonitoredFormat): boolean {
  return props.monitoredFormats == null || props.monitoredFormats.includes(format)
}

/** Formats a request was just sent for from this panel, until the page answers with the work. */
const requestingFormats = ref(new Set<MonitoredFormat>())

const statuses = computed<Record<MonitoredFormat, MonitoredFormatStatus>>(() => {
  const work = props.work
  const fallback: Record<MonitoredFormat, MonitoredFormatStatus> = { ebook: 'unannounced', audiobook: 'unannounced' }
  if (!work) return fallback
  return Object.fromEntries(
    MONITORED_FORMATS.map((format) => [
      format,
      workFormatStatus(work, format, { authorWatches: isFormatMonitored(format), optimisticQueued: requestingFormats.value.has(format) }),
    ]),
  ) as Record<MonitoredFormat, MonitoredFormatStatus>
})

const hiddenByUser = computed(() => props.work?.userVisibility === 'hidden')
const visibilityLabel = computed(() => t(hiddenByUser.value ? 'monitored.panel.unhide' : 'monitored.panel.hide'))

/** The same rule that decides whether this viewer may act on a format at all. */
function canEditFormat(format: MonitoredFormat): boolean {
  return props.canManage && isFormatMonitored(format)
}

function resetReleaseState() {
  openReleases.value = { ebook: false, audiobook: false }
  for (const source of [ebookReleases, audioReleases]) {
    source.releases.value = []
    source.searched.value = false
    source.error.value = null
    source.grabError.value = null
    source.loading.value = false
  }
}

watch(
  () => props.work?.id ?? null,
  () => {
    imageFailed.value = false
    openDatesFormat.value = null
    manualCollapsed.value = {}
    requestingFormats.value = new Set()
    announcedFiled.clear()
    resetReleaseState()
  },
  { immediate: true },
)

// A fresh work from the page is the server's answer to whatever was sent, so the local marker goes.
watch(
  () => props.work,
  () => {
    requestingFormats.value = new Set()
  },
)

watch(
  () => props.work?.matchedBookId ?? null,
  (bookId) => {
    if (bookId != null) void fetchDetail(bookId)
  },
  { immediate: true },
)

watch(
  secondaryBookId,
  (bookId) => {
    if (bookId != null) void fetchSecondaryDetail(bookId)
  },
  { immediate: true },
)

const releaseRows = useReleaseRows(
  computed(() => props.work),
  computed(() => props.canManage),
  (format) => releaseDates.stateFor(format),
)

function rowFor(format: MonitoredFormat) {
  return releaseRows.value.find((row) => row.format === format)!
}

function handleReleaseDatesOpen(format: MonitoredFormat, open: boolean) {
  openDatesFormat.value = open ? format : null
  if (open) void releaseDates.loadCandidates(format)
}

async function applyReleaseDate(format: MonitoredFormat, releaseDate: string | null) {
  const updated = await releaseDates.setDate(format, releaseDate)
  if (!updated) return
  // The panel may have moved to another book while the save was in flight; its popover is not ours to close.
  if (props.work?.id === updated.id) openDatesFormat.value = null
  emit('work-updated', updated)
}

function handleReleaseDateSet(format: MonitoredFormat, releaseDate: string) {
  void applyReleaseDate(format, releaseDate)
}

function handleReleaseDateClear(format: MonitoredFormat) {
  void applyReleaseDate(format, null)
}

async function refreshReleaseDates() {
  const updated = await releaseDates.refresh()
  if (updated) emit('work-updated', updated)
}

function handleRefreshReleaseDates() {
  void refreshReleaseDates()
}

async function answerMatch(format: MonitoredFormat, answer: MonitoredMatchAnswer, workId = props.work?.id ?? null) {
  const updated = await workMatch.answer(format, answer, workId)
  if (!updated) return
  emit('work-updated', updated)
  // Saying a book is not this work's hides it from the format for good, so it gets an undo, bound to
  // this work: the toast outlives the panel moving on to another book.
  if (answer.decision === 'reject') {
    toast.success(t('monitored.slot.match.rejected'), {
      action: { label: t('monitored.slot.match.undo'), onClick: () => void answerMatch(format, { decision: 'automatic' }, updated.id) },
    })
  }
}

function handleAnswerMatch(format: MonitoredFormat, answer: MonitoredMatchAnswer) {
  void answerMatch(format, answer)
}

function handleOpenChange(value: boolean) {
  emit('update:open', value)
}

// The panel is mounted by the page it was opened from, so a link out of it would otherwise leave it
// open over the destination.
const route = useRoute()
watch(
  () => route.path,
  () => {
    if (props.open) emit('update:open', false)
  },
)

function handleImageError() {
  imageFailed.value = true
}

function openReleaseList(format: MonitoredFormat) {
  openReleases.value = { ...openReleases.value, [format]: true }
  const source = releasesFor(format)
  if (props.canManage && !source.searched.value && !source.loading.value) void source.search()
}

function closeReleaseList(format: MonitoredFormat) {
  openReleases.value = { ...openReleases.value, [format]: false }
}

function handleToggleReleases(format: MonitoredFormat) {
  if (openReleases.value[format]) closeReleaseList(format)
  else openReleaseList(format)
}

/**
 * A grab hands the work over to the Requests pipeline. The panel stays where it is: being thrown
 * onto another page to watch a download start is the opposite of what clicking Grab asks for, and
 * the format's request button turns into a link to the request as soon as the page answers.
 */
async function handleGrab(format: MonitoredFormat, release: ReleaseCandidateItem) {
  const work = props.work
  if (!work) return
  const requestId = await releasesFor(format).grab(release)
  if (requestId === null) return
  emit('grabbed', work, format, requestId)
}

function handleRequest(format: MonitoredFormat, autoDownload: boolean) {
  const work = props.work
  if (!work || !canEditFormat(format) || requestingFormats.value.has(format)) return
  requestingFormats.value = new Set([...requestingFormats.value, format])
  emit('request', work, format, autoDownload)
}

function handleAskApproval(format: MonitoredFormat) {
  handleRequest(format, false)
}

function handleToggleMonitor(format: MonitoredFormat, value: boolean) {
  if (props.work) emit('toggle-monitor', props.work, format, value)
}

function handleHide() {
  if (props.work) emit('toggle-hidden', props.work, true)
}

function handleKeep() {
  if (props.work) emit('toggle-hidden', props.work, false)
}

function handleAutomatic() {
  if (props.work) emit('set-automatic', props.work)
}

function handleVisibilityToggle() {
  if (hiddenByUser.value) handleAutomatic()
  else handleHide()
}

function handleSetKind(kind: MonitoredMarkKind) {
  if (props.work) emit('set-kind', props.work, kind)
}

function handleCheckLibrary() {
  emit('check-library')
}

function handleResumeAuthor() {
  emit('resume-author')
}
</script>

<template>
  <Sheet :open="props.open" @update:open="handleOpenChange">
    <SheetContent side="right" hide-close class="w-full gap-0 bg-background p-0 sm:max-w-xl">
      <SheetTitle class="sr-only">{{ work?.title ? t('monitored.panel.titleFor', { title: work.title }) : t('monitored.panel.title') }}</SheetTitle>
      <SheetDescription class="sr-only">{{ t('monitored.panel.description') }}</SheetDescription>

      <div v-if="work" class="flex h-full min-w-0 flex-col bg-background">
        <div class="min-h-0 flex-1 space-y-2.5 overflow-x-hidden overflow-y-auto p-4 sm:p-5">
          <div class="@container">
            <div class="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 sm:gap-x-4 @lg:grid-rows-[auto_1fr]">
              <div class="relative aspect-2/3 w-20 shrink-0 @lg:row-span-2 overflow-hidden rounded-sm shadow-md">
                <img
                  v-if="coverUrl && !imageFailed"
                  :src="coverUrl"
                  :alt="work.title"
                  class="size-full object-cover"
                  loading="eager"
                  @error="handleImageError"
                />
                <BookCoverPlaceholder
                  v-else
                  :title="work.title"
                  :subtitle="work.subtitle"
                  :authors="placeholderAuthors"
                  :series-name="work.seriesName"
                  :series-index="work.seriesIndex"
                  :seed="work.title"
                />
              </div>

              <div class="min-w-0 flex-1">
                <h2
                  class="line-clamp-3 text-[15px] leading-snug font-bold break-words text-foreground"
                  :class="
                    canManage
                      ? 'pe-26 @lg:pe-38 [@media(pointer:coarse)]:pe-36 @lg:[@media(pointer:coarse)]:pe-44'
                      : 'pe-8 [@media(pointer:coarse)]:pe-12'
                  "
                >
                  {{ work.title }}
                </h2>
                <p v-if="showSubtitle" class="mt-0.5 line-clamp-2 text-xs leading-snug break-words text-muted-foreground">{{ work.subtitle }}</p>
                <p class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground" data-testid="byline">
                  <template v-if="authorName">
                    <RouterLink
                      v-if="bylineRoute"
                      :to="bylineRoute"
                      class="font-semibold text-foreground transition-colors hover:text-primary hover:underline underline-offset-2"
                      >{{ authorName }}</RouterLink
                    >
                    <span v-else class="font-semibold text-foreground">{{ authorName }}</span>
                  </template>
                  <template v-if="work.releaseYear">
                    <span v-if="authorName" aria-hidden="true">&middot;</span>
                    <span>{{ work.releaseYear }}</span>
                  </template>
                </p>
                <p
                  v-if="seriesLinks.length"
                  class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
                  data-testid="series-row"
                >
                  <template v-for="(series, index) in visibleSeries" :key="series.label">
                    <span v-if="index > 0" aria-hidden="true">&middot;</span>
                    <RouterLink
                      v-if="series.to"
                      :to="series.to"
                      class="max-w-full truncate transition-colors hover:text-primary hover:underline underline-offset-2"
                      data-testid="series-link"
                      >{{ series.label }}</RouterLink
                    >
                    <span v-else class="max-w-full truncate">{{ series.label }}</span>
                  </template>
                  <span v-if="moreSeries.length" :title="moreSeries.join(', ')" data-testid="series-more">{{
                    t('monitored.panel.moreSeries', { count: moreSeries.length })
                  }}</span>
                </p>
              </div>

              <!-- Pinned to the corner so only the title makes room for it; the byline and series lines run full width. -->
              <div class="absolute -top-1.5 -right-1.5 flex items-center gap-0.5" data-testid="panel-corner">
                <!-- A narrow panel shows Hide as its icon alone, so the title is not squeezed to a word a line. -->
                <button
                  v-if="canManage"
                  type="button"
                  class="inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none @lg:h-7 @lg:border @lg:border-border @lg:px-2 @lg:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                  :aria-label="visibilityLabel"
                  :title="visibilityLabel"
                  data-testid="visibility-toggle"
                  @click="handleVisibilityToggle"
                >
                  <Eye v-if="hiddenByUser" :size="14" aria-hidden="true" />
                  <EyeOff v-else :size="14" aria-hidden="true" />
                  <span class="hidden @lg:inline" aria-hidden="true">{{ visibilityLabel }}</span>
                </button>
                <MonitoredMarkAsMenu v-if="canManage" :work="work" @select="handleSetKind" />
                <SheetClose
                  class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                  :aria-label="t('monitored.panel.close')"
                >
                  <X :size="16" />
                </SheetClose>
              </div>

              <!-- Under the cover while the panel is narrow; beside it, under the title block, once there is room. -->
              <div v-if="workTags.length || ratingLines.length" class="col-span-2 min-w-0 @lg:col-span-1 @lg:col-start-2">
                <MonitoredTagPills :tags="workTags" />
                <p v-if="ratingLines.length" class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="ratings">
                  <Tooltip v-for="rating in ratingLines" :key="rating.source">
                    <TooltipTrigger as-child>
                      <span
                        class="inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        tabindex="0"
                        role="img"
                        :aria-label="rating.count ? `${rating.name} ${rating.average}, ${rating.count}` : `${rating.name} ${rating.average}`"
                        data-testid="rating"
                      >
                        <Star class="size-3 fill-[var(--pill-warning)] text-[var(--pill-warning)]" aria-hidden="true" />
                        <span class="font-medium text-foreground">{{ rating.average }}</span>
                        <span>{{ rating.name }}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent v-if="rating.count">{{ rating.name }} · {{ rating.count }}</TooltipContent>
                  </Tooltip>
                </p>
              </div>
            </div>
          </div>

          <MonitoredVisibilityBanner
            :work="work"
            :author-name="authorName"
            :author-paused="authorPaused"
            :author-route="authorRoute"
            :can-manage="canManage"
            :can-resume-author="canResumeAuthor"
            @keep="handleKeep"
            @hide="handleHide"
            @unhide="handleAutomatic"
            @automatic="handleAutomatic"
            @resume-author="handleResumeAuthor"
          />

          <MonitoredSynopsis :html="work.description ? safeDescription : null" :content-id="`monitored-${work.id}-synopsis`" />

          <section :aria-label="t('book.detail.details.editions')">
            <h3 class="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ t('book.detail.details.editions') }}</h3>
            <div class="mt-2 space-y-2.5">
              <MonitoredFormatSlot
                v-for="format in MONITORED_FORMATS"
                :key="format"
                :work="work"
                :format="format"
                :status="statuses[format]"
                :can-edit="canEditFormat(format)"
                :author-watches="isFormatMonitored(format)"
                :author-route="bylineRoute"
                :can-manage="canManage"
                :mode="formatModes?.[format] ?? null"
                :book="bookFor(bookIdForFormat(format))"
                :book-error="bookFailedFor(bookIdForFormat(format))"
                :row="rowFor(format)"
                :dates-open="openDatesFormat === format"
                :refreshing="releaseDates.refreshing.value"
                :requesting="requestingFormats.has(format)"
                :releases-open="openReleases[format]"
                :checked-at="checkedAt"
                :checking="checking"
                :collapsed="isCollapsed(format)"
                :can-answer-match="canManage"
                :match-saving="workMatch.isSaving(format)"
                @answer-match="handleAnswerMatch"
                @request="handleRequest"
                @toggle-releases="handleToggleReleases"
                @toggle-monitor="handleToggleMonitor"
                @dates-open-change="handleReleaseDatesOpen"
                @date-set="handleReleaseDateSet"
                @date-clear="handleReleaseDateClear"
                @refresh-dates="handleRefreshReleaseDates"
                @retry-book="handleRetryBook"
                @check-library="handleCheckLibrary"
                @toggle-collapsed="handleToggleCollapsed"
                @filed="handleSlotFiled"
              >
                <template #releases="{ canRequest }">
                  <MonitoredSlotReleases
                    :format="format"
                    :source="releasesFor(format)"
                    :can-search="canManage"
                    :can-ask-approval="canRequest"
                    :closable="statuses[format] === 'owned'"
                    @grab="handleGrab"
                    @ask-approval="handleAskApproval"
                    @close="closeReleaseList"
                  />
                </template>
              </MonitoredFormatSlot>
            </div>
          </section>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>
