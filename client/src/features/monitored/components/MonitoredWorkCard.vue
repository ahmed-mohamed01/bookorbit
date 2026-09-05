<script setup lang="ts">
import { computed, ref } from 'vue'
import { BellPlus, BookOpen, Check, Download, Eye, Headphones, Loader2, MoreHorizontal, MoreVertical, PanelRight, Trash2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat, MonitoredSeriesMembership, MonitoredWork } from '@bookorbit/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { releaseDateForWork } from '../lib/grouping'
import { parseMonitoredDate } from '../lib/release-date'

const props = defineProps<{
  work: MonitoredWork
  queued: boolean
  ebookQueued: boolean
  audiobookQueued: boolean
  canManage: boolean
  seriesMembership?: MonitoredSeriesMembership | null
  monitoredFormats?: MonitoredFormat[]
  allowBookMonitoring?: boolean
  individuallyMonitored?: boolean
  monitoringBook?: boolean
  /** Relative release label ("in 7 days", "80 days ago"), shown instead of the default badge. */
  timeBadge?: string | null
}>()
const emit = defineEmits<{
  preview: [work: MonitoredWork]
  quickView: [work: MonitoredWork]
  downloadEbook: [work: MonitoredWork]
  downloadAudiobook: [work: MonitoredWork]
  stop: [work: MonitoredWork]
  monitor: [work: MonitoredWork]
}>()
const { t, d } = useI18n()
const { cardInfoMode } = useDisplaySettings()
const imageFailed = ref(false)

const coverUrl = computed(() => toMonitoredCoverUrl(props.work.coverUrl))
const fallbackStyle = computed(() => bookCoverStyle(props.work.title))
const releaseDate = computed(() => releaseDateForWork(props.work))
const parsedRelease = computed(() => parseMonitoredDate(releaseDate.value))
const isUpcoming = computed(() => parsedRelease.value !== null && parsedRelease.value.date.getTime() > Date.now())
const year = computed(() => String(props.work.releaseYear ?? releaseDate.value?.slice(0, 4) ?? t('monitored.common.tba')))

// The series name lives in the group header, so the card overlay shows only the position within it.
const seriesIndex = computed(() => (props.seriesMembership === undefined ? props.work.seriesIndex : props.seriesMembership?.index))

const showBelowCoverLabel = computed(() => cardInfoMode.value === 'below-cover')
const showHoverTitle = computed(() => cardInfoMode.value === 'hover-overlay')

const queuedBadge = computed(() => ({ label: t('monitored.detail.badges.queued'), class: 'bg-primary text-primary-foreground' }))

const ebookOwned = computed(() => props.work.ownedFormats.includes('ebook') || props.work.matchedBookIds?.ebook != null)
const audiobookOwned = computed(() => props.work.ownedFormats.includes('audiobook') || props.work.matchedBookIds?.audiobook != null)
const ebookPending = computed(() => !ebookOwned.value && (props.ebookQueued || props.work.requestIds.ebook != null))
const audiobookPending = computed(() => !audiobookOwned.value && (props.audiobookQueued || props.work.requestIds.audiobook != null))

const badge = computed(() => {
  // A download that is on its way is newer news than the release date, so it takes the badge.
  if (ebookPending.value || audiobookPending.value) return queuedBadge.value
  if (props.timeBadge) {
    return {
      label: props.timeBadge,
      class: isUpcoming.value ? 'bg-[var(--pill-warning)] text-background' : 'bg-primary text-primary-foreground',
    }
  }
  const release = parsedRelease.value
  if (isUpcoming.value && release) {
    return {
      label: release.precision === 'year' ? String(release.date.getFullYear()) : d(release.date, { month: 'short', year: 'numeric' }),
      class: 'bg-[var(--pill-warning)] text-background',
    }
  }
  return null
})

// A format icon reads as an availability light: green when the book is in the library, amber when it
// is monitored but still missing (wanted), and hidden when that format is not being monitored at all.
type FormatState = 'available' | 'wanted' | 'off'
function formatState(format: MonitoredFormat, owned: boolean): FormatState {
  if (owned) return 'available'
  const monitored = props.monitoredFormats == null || props.monitoredFormats.includes(format)
  return monitored ? 'wanted' : 'off'
}
const ebookState = computed(() => formatState('ebook', ebookOwned.value))
const audiobookState = computed(() => formatState('audiobook', audiobookOwned.value))
// Same colour language as the release rows: success = have it, warning = wanted.
const availabilityIconClass: Record<Exclude<FormatState, 'off'>, string> = {
  available: 'text-success',
  wanted: 'text-warning',
}

function handleImageError() {
  imageFailed.value = true
}

function handlePreview() {
  emit('preview', props.work)
}

function handleQuickView() {
  emit('quickView', props.work)
}

function handleDownloadEbook() {
  if (props.canManage && !ebookOwned.value && !ebookPending.value) emit('downloadEbook', props.work)
}

function handleDownloadAudiobook() {
  if (props.canManage && !audiobookOwned.value && !audiobookPending.value) emit('downloadAudiobook', props.work)
}

function handleStop() {
  if (props.canManage) emit('stop', props.work)
}

function handleMonitorBook() {
  if (
    props.canManage &&
    props.allowBookMonitoring &&
    !props.individuallyMonitored &&
    !props.monitoringBook &&
    (props.monitoredFormats?.length ?? 2) > 0
  ) {
    emit('monitor', props.work)
  }
}
</script>

<template>
  <article class="group min-w-0">
    <div
      class="relative aspect-2/3 overflow-hidden rounded-md shadow-md transition-[box-shadow,transform] duration-150 group-hover:scale-[1.02] group-hover:shadow-xl"
      :style="coverUrl && !imageFailed ? undefined : fallbackStyle"
    >
      <img
        v-if="coverUrl && !imageFailed"
        :src="coverUrl"
        :alt="work.title"
        class="size-full object-cover"
        loading="lazy"
        decoding="async"
        @error="handleImageError"
      />
      <div v-else class="flex size-full items-center justify-center p-3 text-center text-xs font-bold" :style="{ color: fallbackStyle.color }">
        {{ work.title }}
      </div>

      <!-- Cover click opens the quick-look panel; sits under the availability lights and kebab menu. -->
      <button type="button" :aria-label="t('monitored.detail.quickLook')" class="absolute inset-0 z-0 cursor-pointer" @click="handlePreview" />

      <!-- Top-left: persistent availability lights (matches the library read-state indicators) + status -->
      <div class="absolute left-1.5 top-1.5 z-10 flex flex-col items-start gap-1">
        <div class="flex items-center gap-1">
          <span
            v-if="ebookState !== 'off'"
            class="flex items-center justify-center rounded-full bg-black/60 p-1"
            :title="ebookState === 'available' ? t('monitored.detail.ebookOwned') : t('monitored.formats.ebook')"
          >
            <BookOpen :size="12" :class="availabilityIconClass[ebookState]" aria-hidden="true" />
            <span class="sr-only">{{ ebookState === 'available' ? t('monitored.detail.ebookOwned') : t('monitored.detail.ebookWanted') }}</span>
          </span>
          <span
            v-if="audiobookState !== 'off'"
            class="flex items-center justify-center rounded-full bg-black/60 p-1"
            :title="audiobookState === 'available' ? t('monitored.detail.audiobookOwned') : t('monitored.formats.audiobook')"
          >
            <Headphones :size="12" :class="availabilityIconClass[audiobookState]" aria-hidden="true" />
            <span class="sr-only">{{
              audiobookState === 'available' ? t('monitored.detail.audiobookOwned') : t('monitored.detail.audiobookWanted')
            }}</span>
          </span>
        </div>
        <span v-if="badge" class="rounded px-2 py-0.5 text-[10px] font-bold shadow-sm" :class="badge.class">{{ badge.label }}</span>
      </div>

      <!-- Top-right: series position -->
      <span
        v-if="seriesIndex"
        class="absolute right-1.5 top-1.5 z-10 flex items-center rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold leading-none text-white"
        >{{ seriesIndex }}</span
      >

      <!-- Title overlay (on-hover mode): fades in over the cover, like the library grid cards -->
      <div
        v-if="showHoverTitle"
        class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/40 to-transparent px-2 pb-2 pt-9 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      >
        <h3 class="line-clamp-2 pr-8 text-xs font-semibold leading-tight text-white">{{ work.title }}</h3>
        <p class="mt-0.5 truncate pr-8 text-[10px] text-white/75">{{ year }}</p>
      </div>

      <!-- Kebab menu on the cover (on-hover and off modes); below-cover mode carries it in the label row -->
      <DropdownMenu v-if="!showBelowCoverLabel">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="t('monitored.detail.bookMenu', { title: work.title })"
            class="absolute bottom-1.5 right-1.5 z-20 flex size-6 items-center justify-center rounded-md bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          >
            <MoreHorizontal :size="14" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56">
          <DropdownMenuItem @click="handlePreview">
            <PanelRight />
            {{ t('monitored.detail.quickLook') }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="work.matchedBookId === null" @click="handleQuickView">
            <Eye />
            {{ t('monitored.detail.quickView') }}
          </DropdownMenuItem>
          <template v-if="canManage">
            <DropdownMenuItem
              v-if="allowBookMonitoring"
              :disabled="individuallyMonitored || monitoringBook || monitoredFormats?.length === 0"
              @click="handleMonitorBook"
            >
              <Loader2 v-if="monitoringBook" class="animate-spin" />
              <Check v-else-if="individuallyMonitored" />
              <BellPlus v-else />
              {{ individuallyMonitored ? t('monitored.actions.alreadyMonitoringThisBook') : t('monitored.actions.monitorThisBook') }}
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="ebookOwned || ebookPending" @click="handleDownloadEbook">
              <BookOpen v-if="ebookOwned" />
              <Check v-else-if="ebookPending" />
              <Download v-else />
              {{
                ebookOwned ? t('monitored.detail.ebookOwned') : ebookPending ? t('monitored.detail.ebookQueued') : t('monitored.detail.downloadEbook')
              }}
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="audiobookOwned || audiobookPending" @click="handleDownloadAudiobook">
              <Headphones v-if="audiobookOwned" />
              <Check v-else-if="audiobookPending" />
              <Download v-else />
              {{
                audiobookOwned
                  ? t('monitored.detail.audiobookOwned')
                  : audiobookPending
                    ? t('monitored.detail.audiobookQueued')
                    : t('monitored.detail.downloadAudiobook')
              }}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @click="handleStop">
              <Trash2 />
              {{ t('monitored.actions.stopMonitoring') }}
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Below-cover label row (below-cover mode only), mirroring the library grid card layout -->
    <div v-if="showBelowCoverLabel" class="pt-1">
      <div class="flex min-w-0 items-center gap-0.5">
        <p class="min-w-0 flex-1 truncate text-xs font-medium leading-5 text-foreground">{{ work.title }}</p>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :aria-label="t('monitored.detail.bookMenu', { title: work.title })"
              class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <MoreVertical class="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuItem @click="handlePreview">
              <PanelRight />
              {{ t('monitored.detail.quickLook') }}
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="work.matchedBookId === null" @click="handleQuickView">
              <Eye />
              {{ t('monitored.detail.quickView') }}
            </DropdownMenuItem>
            <template v-if="canManage">
              <DropdownMenuItem
                v-if="allowBookMonitoring"
                :disabled="individuallyMonitored || monitoringBook || monitoredFormats?.length === 0"
                @click="handleMonitorBook"
              >
                <Loader2 v-if="monitoringBook" class="animate-spin" />
                <Check v-else-if="individuallyMonitored" />
                <BellPlus v-else />
                {{ individuallyMonitored ? t('monitored.actions.alreadyMonitoringThisBook') : t('monitored.actions.monitorThisBook') }}
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="ebookOwned || ebookPending" @click="handleDownloadEbook">
                <BookOpen v-if="ebookOwned" />
                <Check v-else-if="ebookPending" />
                <Download v-else />
                {{
                  ebookOwned
                    ? t('monitored.detail.ebookOwned')
                    : ebookPending
                      ? t('monitored.detail.ebookQueued')
                      : t('monitored.detail.downloadEbook')
                }}
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="audiobookOwned || audiobookPending" @click="handleDownloadAudiobook">
                <Headphones v-if="audiobookOwned" />
                <Check v-else-if="audiobookPending" />
                <Download v-else />
                {{
                  audiobookOwned
                    ? t('monitored.detail.audiobookOwned')
                    : audiobookPending
                      ? t('monitored.detail.audiobookQueued')
                      : t('monitored.detail.downloadAudiobook')
                }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @click="handleStop">
                <Trash2 />
                {{ t('monitored.actions.stopMonitoring') }}
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p class="truncate text-[0.675rem] leading-3.5 text-muted-foreground">{{ year }}</p>
    </div>
  </article>
</template>
