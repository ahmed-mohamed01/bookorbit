<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, Bell, BellOff, BookCopy, BookOpen, ChevronUp, Folder, Headphones, Link2, RefreshCw } from '@lucide/vue'
import {
  monitoredFormatReleaseDate,
  monitoredReleaseStarted,
  type BookDetail,
  type MonitorMode,
  type MonitoredFormat,
  type MonitoredMatchHolder,
  type MonitoredWork,
} from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatBytes } from '@/lib/formatting'
import { fetchMatchHolders } from '../api/monitored'
import { useFormatSlotState } from '../composables/useFormatSlotState'
import type { MonitoredMatchAnswer } from '../composables/useWorkMatch'
import type { MonitoredReleaseRow } from '../composables/useReleaseRows'
import type { MonitoredFormatStatus } from '../lib/format-status'
import MonitoredOwnedTree from './MonitoredOwnedTree.vue'
import MonitoredMatchFilePicker from './MonitoredMatchFilePicker.vue'
import MonitoredPossibleMatch from './MonitoredPossibleMatch.vue'
import MonitoredSlotDates from './MonitoredSlotDates.vue'
import MonitoredSlotFooter from './MonitoredSlotFooter.vue'

/** One format of a monitored work as its own card: identity, stat line, status, body, footer. */
const props = defineProps<{
  work: MonitoredWork
  format: MonitoredFormat
  status: MonitoredFormatStatus
  /** May send requests and change what is watched, and the author monitors this format. */
  canEdit: boolean
  /** The author monitors this format at all. */
  authorWatches: boolean
  /** May look release dates up, change them, and run a disk check. */
  canManage: boolean
  /** Where the author's monitored page is, when the panel is not already on it. */
  authorRoute?: { name: string; params: { id: string } } | null
  /** The author's mode for this format. */
  mode?: MonitorMode | null
  /** The library book holding this format, once loaded. */
  book?: BookDetail | null
  bookError?: boolean
  row: MonitoredReleaseRow
  datesOpen: boolean
  refreshing: boolean
  requesting: boolean
  releasesOpen: boolean
  /** When the author's files were last checked; null before the first check. */
  checkedAt?: string | null
  checking?: boolean
  /** Shows the identity row only. */
  collapsed?: boolean
  /** May say which library book this format is: link, unlink, or answer a possible match. */
  canAnswerMatch?: boolean
  matchSaving?: boolean
}>()
const emit = defineEmits<{
  request: [format: MonitoredFormat, autoDownload: boolean]
  'toggle-releases': [format: MonitoredFormat]
  'toggle-monitor': [format: MonitoredFormat, value: boolean]
  'dates-open-change': [format: MonitoredFormat, open: boolean]
  'date-set': [format: MonitoredFormat, releaseDate: string]
  'date-clear': [format: MonitoredFormat]
  'refresh-dates': []
  'retry-book': [format: MonitoredFormat]
  'check-library': [format: MonitoredFormat]
  'toggle-collapsed': [format: MonitoredFormat]
  filed: [requestId: number]
  'answer-match': [format: MonitoredFormat, answer: MonitoredMatchAnswer, moveFrom?: MonitoredMatchHolder[]]
}>()

defineSlots<{ releases(props: { canRequest: boolean }): unknown }>()

const { t } = useI18n()

const state = useFormatSlotState(props, (id) => emit('filed', id))
const icon = computed(() => (props.format === 'audiobook' ? Headphones : BookOpen))
/** Each format's colour, and grey for a format that is not watched, so a switched-off card reads as off. */
const TONES = {
  ebook: {
    text: 'text-[var(--pill-media-ebook)]',
    bar: 'bg-[var(--pill-media-ebook)]/70',
    tile: 'bg-[var(--pill-media-ebook)]/14',
    pill: 'border-[var(--pill-media-ebook)]/40 bg-[var(--pill-media-ebook)]/10 text-[var(--pill-media-ebook)]',
  },
  audiobook: {
    text: 'text-[var(--pill-media-audiobook)]',
    bar: 'bg-[var(--pill-media-audiobook)]/70',
    tile: 'bg-[var(--pill-media-audiobook)]/14',
    pill: 'border-[var(--pill-media-audiobook)]/40 bg-[var(--pill-media-audiobook)]/10 text-[var(--pill-media-audiobook)]',
  },
  off: {
    text: 'text-muted-foreground',
    bar: 'bg-muted-foreground/40',
    tile: 'bg-muted',
    pill: 'border-border bg-muted text-muted-foreground',
  },
} as const
const tone = computed(() => TONES[state.watching.value ? props.format : 'off'])
const toneText = computed(() => tone.value.text)
const toneBg = computed(() => tone.value.bar)
const tileBg = computed(() => tone.value.tile)
const kindPill = computed(() => tone.value.pill)
const formatLower = computed(() => state.formatName.value.toLowerCase())
const collapseLabel = computed(() => t(props.collapsed ? 'monitored.slot.expand' : 'monitored.slot.collapse'))
const watchHintId = computed(() => `${props.work.id}-${props.format}-watch-hint`)
const watchLabel = computed(() => t('monitored.slot.watchFormat', { format: formatLower.value }))

/** The empty state's second line: the release on its way, or what this viewer can do about the gap. */
const emptyHint = computed(() => {
  const release = state.requestRelease.value
  if (release) return release.sizeBytes != null ? `${release.title} · ${formatBytes(release.sizeBytes)}` : release.title
  if (!props.canEdit) return null
  return state.watching.value ? t('monitored.slot.emptyHintWatching') : t('monitored.slot.emptyHintNotWatching')
})

const possibleMatch = computed(() => (state.owned.value ? null : (props.work.possibleMatches?.[props.format] ?? null)))
const linkedByHand = computed(() => props.work.linkedFormats?.includes(props.format) ?? false)
const ownedBookId = computed(() => props.work.matchedBookIds?.[props.format] ?? null)
/** Undoing a match needs the book it points at; a format owned only through a filed request has none to name. */
const canUnlink = computed(() => !!props.canAnswerMatch && state.owned.value && ownedBookId.value != null)

/**
 * A format the matcher found nothing for can still be in the library under another name, unless its
 * release date is still ahead. No known date is no evidence it is unreleased.
 */
const canMatchFile = computed(() => {
  if (!props.canAnswerMatch || state.owned.value || state.requestMoving.value) return false
  const { date, precision } = monitoredFormatReleaseDate(props.work, props.format)
  return !date || monitoredReleaseStarted(date, precision, new Date().toISOString().slice(0, 10))
})

function handleAnswerMatch(format: MonitoredFormat, answer: MonitoredMatchAnswer, moveFrom?: MonitoredMatchHolder[]) {
  emit('answer-match', format, answer, moveFrom)
}

/** Other works of this author holding the same file, so a shared file is never a surprise. */
const sharedWith = ref<MonitoredMatchHolder[]>([])
let holdersRequest: AbortController | null = null
watch(
  [() => props.work.id, ownedBookId, () => !!props.canAnswerMatch],
  async ([workId, bookId, canAnswer]) => {
    holdersRequest?.abort()
    sharedWith.value = []
    if (!canAnswer || bookId == null) return
    const controller = new AbortController()
    holdersRequest = controller
    try {
      const holders = await fetchMatchHolders(workId, props.format, bookId, controller.signal)
      if (!controller.signal.aborted) sharedWith.value = holders
    } catch {
      // The line is a convenience; a failed lookup just leaves it out.
    }
  },
  { immediate: true },
)

function holderRoute(holder: MonitoredMatchHolder) {
  return { name: 'monitored-author', params: { id: holder.monitorId }, query: { work: holder.workId } }
}

function handleToggleWatch() {
  emit('toggle-monitor', props.format, !state.watching.value)
}

function handleRequest(format: MonitoredFormat) {
  emit('request', format, true)
}

function handleToggleReleases(format: MonitoredFormat) {
  emit('toggle-releases', format)
}

function handleDatesOpenChange(format: MonitoredFormat, open: boolean) {
  emit('dates-open-change', format, open)
}

function handleDateSet(format: MonitoredFormat, releaseDate: string) {
  emit('date-set', format, releaseDate)
}

function handleDateClear(format: MonitoredFormat) {
  emit('date-clear', format)
}

function handleRefreshDates() {
  emit('refresh-dates')
}

function handleRetryBook() {
  emit('retry-book', props.format)
}

function handleToggleCollapsed() {
  emit('toggle-collapsed', props.format)
}

function handleCheckLibrary() {
  emit('check-library', props.format)
}
</script>

<template>
  <section class="relative overflow-hidden rounded-[10px] border border-border bg-card shadow-sm" :data-format="format" :data-status="status">
    <span class="absolute inset-y-0 left-0 w-[3px]" :class="toneBg" aria-hidden="true" />
    <div class="flex flex-col gap-2 p-2.5 ps-3">
      <div class="flex items-center gap-2">
        <div class="flex size-7 shrink-0 items-center justify-center rounded-md" :class="tileBg">
          <component :is="icon" :size="15" :class="toneText" aria-hidden="true" />
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 class="text-sm leading-tight font-semibold text-foreground">{{ state.formatName.value }}</h3>
          <span
            v-if="state.owned.value"
            class="inline-flex items-center gap-1 rounded-md border border-[var(--pill-success)]/40 bg-[var(--pill-success)]/12 px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-[var(--pill-success)]"
          >
            {{ t('monitored.slot.inLibrary') }}
          </span>
          <span
            v-else
            class="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-muted-foreground"
            data-testid="not-in-library"
          >
            {{ t('monitored.slot.notInLibrary') }}
          </span>
        </div>
        <RouterLink
          v-if="state.owned.value && state.bookRoute.value"
          :to="state.bookRoute.value"
          class="ms-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-label="t('monitored.panel.openBookFormat', { format: formatLower })"
          :title="t('monitored.panel.openBook')"
          data-testid="library-link"
        >
          <ArrowUpRight :size="15" aria-hidden="true" />
        </RouterLink>
        <TooltipProvider v-if="linkedByHand && state.owned.value">
          <Tooltip>
            <TooltipTrigger as-child>
              <span
                tabindex="0"
                class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-primary"
                :class="state.bookRoute.value ? undefined : 'ms-auto'"
                data-testid="linked-by-hand"
              >
                <Link2 :size="15" aria-hidden="true" />
                <span class="sr-only">{{ t('monitored.slot.match.linkedIndicator') }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent class="max-w-64">{{ t('monitored.slot.match.linkedIndicator') }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:size-11"
                :class="(state.owned.value && state.bookRoute.value) || (linkedByHand && state.owned.value) ? undefined : 'ms-auto'"
                :aria-expanded="!collapsed"
                :aria-label="collapseLabel"
                data-testid="slot-collapse"
                @click="handleToggleCollapsed"
              >
                <ChevronUp :size="15" class="transition-transform" :class="collapsed ? 'rotate-180' : undefined" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ collapseLabel }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <template v-if="!collapsed">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p
            v-if="state.owned.value && state.ownedBody.value === 'file'"
            class="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground"
            data-testid="slot-stat"
          >
            <span
              v-if="state.statKind.value"
              class="inline-flex items-center rounded-md border px-1.5 py-px text-[11px] font-semibold tracking-wider"
              :class="kindPill"
              data-testid="slot-kind"
              >{{ state.statKind.value }}</span
            >
            <span class="tabular-nums">
              {{ t('monitored.slot.fileCount', { count: state.fileCount.value })
              }}<template v-if="state.editionSizeBytes.value != null"> &middot; {{ formatBytes(state.editionSizeBytes.value) }}</template>
            </span>
            <span
              v-if="book?.libraryName"
              class="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-px text-[11px] font-medium text-muted-foreground"
              data-testid="slot-library"
            >
              <BookCopy :size="11" class="shrink-0" aria-hidden="true" />
              <span class="truncate">{{ book.libraryName }}</span>
            </span>
          </p>
          <div v-else-if="!state.owned.value" class="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
            <MonitoredSlotDates
              :format="format"
              :row="row"
              :label="state.chipLabel.value"
              :open="datesOpen"
              :can-manage="canManage"
              :refreshing="refreshing"
              @open-change="handleDatesOpenChange"
              @set="handleDateSet"
              @clear="handleDateClear"
              @refresh="handleRefreshDates"
            />
          </div>

          <!-- What the switch means ("Searched automatically", "Never searched") lives in its tooltip, keeping this one row. -->
          <TooltipProvider v-if="canEdit">
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  role="switch"
                  class="ms-auto -me-1.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  :class="state.watching.value ? 'text-primary' : 'text-muted-foreground'"
                  :aria-checked="state.watching.value"
                  :aria-label="watchLabel"
                  :aria-describedby="watchHintId"
                  data-testid="watch-toggle"
                  @click="handleToggleWatch"
                >
                  <Bell v-if="state.watching.value" :size="12" aria-hidden="true" />
                  <BellOff v-else :size="12" aria-hidden="true" />
                  {{ state.watching.value ? t('monitored.slot.watching') : t('monitored.slot.notWatching') }}
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ state.watchTooltip.value }}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span v-if="canEdit" :id="watchHintId" class="sr-only">{{ state.watchTooltip.value }}</span>
          <span
            v-else-if="!state.statusLine.value"
            class="ms-auto inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium"
            :class="state.watching.value ? 'text-primary' : 'text-muted-foreground'"
          >
            <Bell v-if="state.watching.value" :size="12" aria-hidden="true" />
            <BellOff v-else :size="12" aria-hidden="true" />
            {{ state.watching.value ? t('monitored.slot.watching') : t('monitored.slot.notWatching') }}
          </span>
        </div>

        <p v-if="!canEdit && state.statusLine.value" class="text-[12.5px]">
          <span :class="state.statusLine.value.tone" data-testid="slot-status">{{ state.statusLine.value.text }}</span>
          <RouterLink
            v-if="state.statusLine.value.authorLink && authorRoute"
            :to="authorRoute"
            class="ms-1.5 font-medium text-foreground underline-offset-2 hover:underline"
            data-testid="slot-author-link"
            >{{ t('monitored.slot.openAuthor') }}</RouterLink
          >
        </p>

        <MonitoredOwnedTree
          v-if="state.owned.value && state.ownedBody.value === 'file' && state.fileName.value"
          class="rounded-md border border-dashed border-muted-foreground/35 px-2.5 py-1.5"
          :format="format"
          :library-name="book?.libraryName ?? ''"
          :library-id="book?.libraryId"
          :file-name="state.fileName.value"
          :file-path="state.filePath.value"
          :files="book?.files"
          :content-paths="state.contentPaths.value"
          :recheckable="canManage"
          :checking="checking"
          @recheck="handleCheckLibrary"
        >
          <template v-if="canUnlink" #action>
            <MonitoredMatchFilePicker
              :work="work"
              :format="format"
              :saving="!!matchSaving"
              :current-book-id="ownedBookId"
              :linked-by-hand="linkedByHand"
              @answer="handleAnswerMatch"
            />
          </template>
        </MonitoredOwnedTree>
        <div
          v-else-if="state.owned.value && state.ownedBody.value === 'error'"
          class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
          role="alert"
          data-testid="owned-error"
        >
          <p class="text-xs text-destructive">{{ t('monitored.slot.ownedLoadFailed') }}</p>
          <button
            type="button"
            class="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
            data-testid="owned-retry"
            @click="handleRetryBook"
          >
            {{ t('monitored.slot.ownedRetry') }}
          </button>
        </div>
        <div
          v-else-if="state.owned.value && state.ownedBody.value === 'loading'"
          class="h-10 min-w-0 animate-pulse rounded-md bg-muted"
          aria-hidden="true"
        />
        <div v-else-if="state.owned.value" class="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground" data-testid="owned-no-file">{{ t('monitored.slot.ownedNoFile') }}</p>
          <button
            v-if="canManage"
            type="button"
            class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
            :disabled="checking"
            data-testid="owned-check"
            @click="handleCheckLibrary"
          >
            <RefreshCw :size="13" :class="checking ? 'motion-safe:animate-spin' : undefined" aria-hidden="true" />
            {{ t('monitored.slot.check') }}
          </button>
        </div>
        <MonitoredPossibleMatch
          v-else-if="possibleMatch"
          :work="work"
          :format="format"
          :possible="possibleMatch"
          :can-answer="!!canAnswerMatch"
          :saving="!!matchSaving"
          @answer="handleAnswerMatch"
        >
          <MonitoredMatchFilePicker :work="work" :format="format" :saving="!!matchSaving" @answer="handleAnswerMatch" />
        </MonitoredPossibleMatch>
        <div
          v-else
          class="flex min-w-0 items-center gap-2 rounded-md border border-dashed border-muted-foreground/35 px-2.5 py-1.5 text-xs text-muted-foreground"
          data-testid="slot-empty"
        >
          <RefreshCw
            v-if="state.requestMoving.value"
            :size="13"
            class="shrink-0"
            :class="state.requestKind.value === 'downloading' ? 'motion-safe:animate-spin' : undefined"
            aria-hidden="true"
          />
          <Folder v-else :size="13" class="shrink-0" aria-hidden="true" />
          <p class="min-w-0">
            <span class="font-medium text-foreground">{{
              state.requestMoving.value ? t('monitored.slot.onItsWay') : t('monitored.slot.emptyTitle')
            }}</span>
            <template v-if="emptyHint"> &middot; {{ emptyHint }}</template>
          </p>
          <MonitoredMatchFilePicker v-if="canMatchFile" :work="work" :format="format" :saving="!!matchSaving" @answer="handleAnswerMatch" />
        </div>
        <p
          v-if="state.owned.value && sharedWith.length > 0"
          class="flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground"
          data-testid="slot-shared-with"
        >
          <Link2 :size="12" class="shrink-0" aria-hidden="true" />
          <span>{{ t('monitored.slot.match.alsoLinkedTo') }}</span>
          <template v-for="(holder, index) in sharedWith" :key="holder.workId">
            <RouterLink :to="holderRoute(holder)" class="font-medium text-foreground underline-offset-2 hover:underline">{{
              holder.title
            }}</RouterLink
            ><span v-if="index < sharedWith.length - 1">,</span>
          </template>
        </p>
      </template>
    </div>

    <MonitoredSlotFooter
      v-if="!collapsed"
      :format="format"
      :owned="state.owned.value"
      :available-since="state.availableSince.value"
      :released-label="state.releasedLabel.value"
      :releases-open="releasesOpen"
      :can-edit="canEdit"
      :can-manage="canManage"
      :checked-at="checkedAt"
      :checking="checking"
      :request-kind="state.requestKind.value"
      :request-route="state.requestRoute.value"
      :can-request="state.canRequest.value"
      :busy="requesting"
      :hint="state.requestHint.value"
      :releases-blocked-hint="state.releasesBlockedHint.value"
      :releases-toggle-label="state.releasesToggleLabel.value"
      :download="state.download.value"
      @check="handleCheckLibrary"
      @toggle-releases="handleToggleReleases"
      @request="handleRequest"
    />

    <div v-if="releasesOpen && !collapsed" class="border-t border-border p-3 ps-3.5" data-testid="slot-releases">
      <p v-if="state.owned.value" class="mb-2 text-xs text-muted-foreground" data-testid="owned-releases-note">
        {{ t('monitored.slot.ownedReleasesNote', { format: formatLower }) }}
      </p>
      <slot name="releases" :can-request="state.requestOffered.value" />
    </div>
  </section>
</template>
