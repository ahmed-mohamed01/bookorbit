<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLongPress } from '@vueuse/core'
import { BookOpen, Check, Download, EyeOff, Headphones, MoreVertical } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_FORMATS, type MonitorMode, type MonitoredFormat, type MonitoredSeriesMembership, type MonitoredWork } from '@bookorbit/types'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { cardBadgeKind, cardBadgeTone, type CardBadgeKind } from '../lib/card-badge'
import { ACTIVE_REQUEST_STATUSES, workFormatStatus, type MonitoredFormatStatus } from '../lib/format-status'
import { releaseDateForWork } from '../lib/grouping'
import { releaseTimeBadge, type TimeBadge } from '../lib/time-badge'
import { workKindOf, workDisplayClass } from '../lib/work-visibility'
import { useFormatStatusText } from '../composables/useFormatStatusText'
import MonitoredCardMenu, { type CardFormatMenu } from './MonitoredCardMenu.vue'

const props = withDefaults(
  defineProps<{
    work: MonitoredWork
    queued: boolean
    ebookQueued: boolean
    audiobookQueued: boolean
    canManage: boolean
    seriesMembership?: MonitoredSeriesMembership | null
    monitoredFormats?: MonitoredFormat[]
    /** The author's mode per format, so a badge can say what happens on release. */
    formatModes?: Partial<Record<MonitoredFormat, MonitorMode>>
    /** Shown on hover when the card stands outside its author's page. */
    authorName?: string | null
    /** Relative release label and whether it points forward; worked out from the work's own date when absent. */
    timeBadge?: TimeBadge | null
    selectionMode?: boolean
    selected?: boolean
    /** False for a card the viewer cannot act on; it stays visible but cannot be picked. */
    selectable?: boolean
    /** Lets a long press on the cover enter select mode with this card picked. */
    longPressSelect?: boolean
  }>(),
  { selectable: true },
)
const emit = defineEmits<{
  preview: [work: MonitoredWork]
  quickView: [work: MonitoredWork]
  downloadEbook: [work: MonitoredWork]
  downloadAudiobook: [work: MonitoredWork]
  stop: [work: MonitoredWork]
  select: [work: MonitoredWork, event: MouseEvent]
  longPress: [work: MonitoredWork]
}>()
const { t } = useI18n()
const { sentence } = useFormatStatusText()
const { cardInfoMode } = useDisplaySettings()
const imageFailed = ref(false)
const showBelowCoverLabel = computed(() => cardInfoMode.value === 'below-cover')
const inSelectMode = computed(() => props.selectionMode === true)
const isSelectable = computed(() => props.selectable)
const coverLabel = computed(() => {
  if (!inSelectMode.value) return t('monitored.detail.quickLook')
  return t(props.selected ? 'monitored.selection.card.deselect' : 'monitored.selection.card.select', { title: props.work.title })
})

const coverUrl = computed(() => toMonitoredCoverUrl(props.work.coverUrl))
const fallbackStyle = computed(() => bookCoverStyle(props.work.title))

const badgeTime = computed<TimeBadge | null>(() =>
  props.timeBadge !== undefined ? props.timeBadge : releaseTimeBadge(releaseDateForWork(props.work), t),
)
const timeTone = computed(() => (badgeTime.value?.upcoming ? 'bg-[var(--pill-warning)]' : 'bg-[var(--pill-info)]'))

const seriesIndex = computed(() => (props.seriesMembership === undefined ? props.work.seriesIndex : props.seriesMembership?.index))
// Grouped by series, the group heading names the series and the number alone is enough. Anywhere
// else the number means nothing without the name, so the card names the series instead.
const seriesLabel = computed(() => (props.seriesMembership !== undefined && seriesIndex.value ? `#${seriesIndex.value}` : ''))
const seriesLine = computed(() => {
  if (props.seriesMembership !== undefined) return ''
  const membership = props.work.seriesMemberships?.[0]
  if (!membership?.name) return ''
  const number = membership.index ? `#${membership.index}` : ''
  return number ? `${number} · ${membership.name}` : membership.name
})

const displayClass = computed(() => workDisplayClass(props.work))
const kindLabel = computed(() => {
  const kind = workKindOf(props.work)
  if (kind && kind !== 'book') return t(`monitored.review.badges.${kind}`)
  return displayClass.value === 'unconfirmed' ? t('monitored.review.badges.other') : null
})
const isHidden = computed(() => displayClass.value === 'hidden')

function authorWatches(format: MonitoredFormat): boolean {
  return props.monitoredFormats == null || props.monitoredFormats.includes(format)
}

const statuses = computed<Record<MonitoredFormat, MonitoredFormatStatus>>(() => ({
  ebook: workFormatStatus(props.work, 'ebook', { authorWatches: authorWatches('ebook'), optimisticQueued: props.ebookQueued }),
  audiobook: workFormatStatus(props.work, 'audiobook', { authorWatches: authorWatches('audiobook'), optimisticQueued: props.audiobookQueued }),
}))

const fullyOwned = computed(() => MONITORED_FORMATS.every((format) => statuses.value[format] === 'owned'))
const notWatched = computed(() => MONITORED_FORMATS.every((format) => statuses.value[format] === 'not_watching'))

interface FormatBadge {
  format: MonitoredFormat
  kind: CardBadgeKind
  tone: string
  title: string
}

const badges = computed<FormatBadge[]>(() =>
  MONITORED_FORMATS.flatMap((format) => {
    const status = statuses.value[format]
    const kind = cardBadgeKind(status)
    if (!kind) return []
    return [
      {
        format,
        kind,
        tone: cardBadgeTone(kind, format),
        title: sentence(props.work, format, status, { mode: props.formatModes?.[format] ?? null }),
      },
    ]
  }),
)

function menuState(format: MonitoredFormat): CardFormatMenu {
  const status = statuses.value[format]
  const owned = status === 'owned'
  const pending = ACTIVE_REQUEST_STATUSES.has(status)
  const label = owned
    ? t(`monitored.detail.${format}Owned`)
    : pending
      ? sentence(props.work, format, status)
      : t(format === 'ebook' ? 'monitored.detail.downloadEbook' : 'monitored.detail.downloadAudiobook')
  return { disabled: owned || pending, label, owned, pending }
}

const canQuickView = computed(() => props.work.matchedBookId !== null)
const subline = computed(() => props.authorName ?? (props.work.releaseYear ? String(props.work.releaseYear) : ''))

const ebookMenu = computed(() => menuState('ebook'))
const audiobookMenu = computed(() => menuState('audiobook'))

function handleImageError() {
  imageFailed.value = true
}

function handlePreview() {
  emit('preview', props.work)
}

const coverButton = ref<HTMLButtonElement | null>(null)
// The release of a long press usually lands on the cover as a click, which must not also open the
// preview or toggle the freshly selected card. Touch browsers often send no click at all, so the
// swallow is tied to the release itself and only holds briefly, never eating a later genuine tap.
const LONG_PRESS_SWALLOW_WINDOW_MS = 300
let longPressPendingRelease = false
let longPressReleasedAt: number | null = null

function handleLongPress() {
  if (!props.longPressSelect || inSelectMode.value) return
  longPressPendingRelease = true
  emit('longPress', props.work)
}

function handleLongPressRelease(duration: number, distance: number, isLongPress: boolean) {
  const fromLongPress = isLongPress && longPressPendingRelease
  longPressPendingRelease = false
  if (fromLongPress) longPressReleasedAt = Date.now()
}

function handleCoverClick(event: MouseEvent) {
  const swallowReleaseClick = longPressReleasedAt !== null && Date.now() - longPressReleasedAt <= LONG_PRESS_SWALLOW_WINDOW_MS
  longPressReleasedAt = null
  if (swallowReleaseClick) return
  if (inSelectMode.value) {
    if (isSelectable.value) emit('select', props.work, event)
    return
  }
  // A tap opens the panel on touch screens too: a first tap that only revealed a Quick look button made
  // every book take two.
  handlePreview()
}

function handleCoverContextmenu(event: MouseEvent) {
  if (props.longPressSelect) event.preventDefault()
}

onLongPress(coverButton, handleLongPress, { delay: 500, onMouseUp: handleLongPressRelease })

function handleQuickView() {
  emit('quickView', props.work)
}

function handleDownloadEbook() {
  if (props.canManage && !ebookMenu.value.disabled) emit('downloadEbook', props.work)
}

function handleDownloadAudiobook() {
  if (props.canManage && !audiobookMenu.value.disabled) emit('downloadAudiobook', props.work)
}

function handleStop() {
  if (props.canManage) emit('stop', props.work)
}
</script>

<template>
  <article
    class="group min-w-0"
    :class="{ 'opacity-45': isHidden, 'opacity-50': inSelectMode && !isSelectable }"
    :data-owned="fullyOwned || undefined"
    :data-not-watched="notWatched || undefined"
  >
    <div
      class="relative aspect-2/3 overflow-hidden rounded-sm shadow-md transition-[box-shadow,transform,filter] duration-150 group-hover:scale-[1.02] group-hover:shadow-xl motion-reduce:group-hover:scale-100"
      :class="{ 'brightness-75 saturate-50 group-hover:brightness-100 group-hover:saturate-100': notWatched }"
      :style="coverUrl && !imageFailed ? undefined : fallbackStyle"
    >
      <img
        v-if="coverUrl && !imageFailed"
        :src="coverUrl"
        :alt="work.title"
        class="size-full object-cover"
        :class="longPressSelect ? '[-webkit-touch-callout:none] select-none' : ''"
        loading="lazy"
        decoding="async"
        @error="handleImageError"
      />
      <div v-else class="flex size-full items-center justify-center p-3 text-center text-xs font-bold" :style="{ color: fallbackStyle.color }">
        {{ work.title }}
      </div>

      <button
        ref="coverButton"
        type="button"
        :aria-label="coverLabel"
        :aria-pressed="inSelectMode ? Boolean(selected) : undefined"
        :disabled="inSelectMode && !isSelectable"
        class="absolute inset-0 z-0"
        :class="[
          inSelectMode && !isSelectable ? 'cursor-not-allowed' : 'cursor-pointer',
          longPressSelect ? '[-webkit-touch-callout:none] select-none' : '',
        ]"
        data-testid="cover-button"
        @click="handleCoverClick"
        @contextmenu="handleCoverContextmenu"
      />

      <div
        v-if="inSelectMode"
        class="pointer-events-none absolute inset-0 z-30 rounded-sm"
        :class="selected ? 'bg-primary/20 ring-2 ring-inset ring-primary' : ''"
        data-testid="select-overlay"
      >
        <div
          class="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-xs transition-colors"
          :class="selected ? 'bg-primary' : isSelectable ? 'border border-white/50 bg-black/40' : 'border border-white/30 bg-black/20'"
          data-testid="select-box"
        >
          <Check v-if="selected" class="text-primary-foreground" :size="12" aria-hidden="true" />
        </div>
      </div>

      <div class="pointer-events-none absolute left-1.5 flex flex-col items-start gap-1" :class="inSelectMode ? 'top-8 z-40' : 'top-1.5 z-20'">
        <span
          v-if="isHidden"
          class="flex items-center justify-center rounded-sm bg-black/60 p-1 text-white"
          :title="t('monitored.card.hidden')"
          data-testid="hidden-mark"
        >
          <EyeOff :size="12" aria-hidden="true" />
          <span class="sr-only">{{ t('monitored.card.hidden') }}</span>
        </span>
        <span
          v-else-if="badgeTime && !inSelectMode"
          class="rounded-sm px-2 py-1 text-[11px] font-semibold leading-none text-background shadow-sm"
          :class="timeTone"
          :data-tone="badgeTime.upcoming ? 'upcoming' : 'released'"
          data-testid="time-badge"
          >{{ badgeTime.label }}</span
        >
        <span v-if="kindLabel && !inSelectMode" class="rounded-sm bg-black/60 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">{{
          kindLabel
        }}</span>
        <span v-if="badges.length" class="flex items-center gap-1">
          <span
            v-for="badge in badges"
            :key="badge.format"
            class="relative inline-flex size-6 items-center justify-center rounded-sm border shadow-[0_1px_3px_rgb(0_0_0/0.6)]"
            :class="badge.tone"
            :data-badge="badge.kind"
            :data-format="badge.format"
            :title="badge.title"
          >
            <BookOpen v-if="badge.format === 'ebook'" class="size-3.5" aria-hidden="true" />
            <Headphones v-else class="size-3.5" aria-hidden="true" />
            <Download
              v-if="badge.kind === 'downloading'"
              class="absolute -bottom-1 -right-1 size-3 rounded-full bg-background p-px text-[var(--pill-info)]"
              aria-hidden="true"
            />
            <span class="sr-only">{{ badge.title }}</span>
          </span>
        </span>
      </div>

      <span
        v-if="seriesLabel"
        class="pointer-events-none absolute right-1.5 top-1.5 z-20 flex items-center rounded-sm bg-black/60 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white"
        data-testid="series-badge"
        >{{ seriesLabel }}</span
      >

      <span
        v-if="seriesLine && !showBelowCoverLabel"
        class="pointer-events-none absolute bottom-1.5 left-1.5 z-10 max-w-[calc(100%-2.75rem)] truncate rounded-sm bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-white transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0"
        :title="seriesLine"
        data-testid="series-line"
        >{{ seriesLine }}</span
      >
      <div
        v-if="!showBelowCoverLabel && !inSelectMode"
        class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col justify-end bg-gradient-to-t from-black/85 via-black/55 to-transparent p-2 pt-12 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
        data-testid="info-overlay"
      >
        <div class="min-w-0">
          <p class="line-clamp-2 pr-8 text-xs font-semibold leading-tight text-white" data-testid="hover-title">{{ work.title }}</p>
          <p v-if="authorName" class="truncate text-[10px] text-white/70" data-testid="hover-author">{{ authorName }}</p>
          <p v-if="seriesLine" class="truncate text-[10px] text-white/70" data-testid="hover-series">{{ seriesLine }}</p>
        </div>
      </div>

      <div
        v-if="!showBelowCoverLabel && !inSelectMode"
        class="absolute bottom-2 right-2 z-20 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        <MonitoredCardMenu
          :can-manage="canManage"
          :can-quick-view="canQuickView"
          :ebook="ebookMenu"
          :audiobook="audiobookMenu"
          @preview="handlePreview"
          @quick-view="handleQuickView"
          @download-ebook="handleDownloadEbook"
          @download-audiobook="handleDownloadAudiobook"
          @stop="handleStop"
        >
          <!-- The invisible ring around the round button keeps the tap target past 44px. -->
          <button
            type="button"
            :aria-label="t('monitored.detail.bookMenu', { title: work.title })"
            class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-black/45 text-white transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-white/30 [@media(pointer:coarse)]:size-8"
          >
            <MoreVertical class="size-3.5" />
          </button>
        </MonitoredCardMenu>
      </div>
    </div>

    <div v-if="showBelowCoverLabel" class="pt-1" data-testid="below-cover-label">
      <div class="flex min-w-0 items-center gap-0.5">
        <p class="min-w-0 flex-1 truncate text-xs font-medium leading-5 text-foreground">{{ work.title }}</p>
        <MonitoredCardMenu
          v-if="!inSelectMode"
          :can-manage="canManage"
          :can-quick-view="canQuickView"
          :ebook="ebookMenu"
          :audiobook="audiobookMenu"
          @preview="handlePreview"
          @quick-view="handleQuickView"
          @download-ebook="handleDownloadEbook"
          @download-audiobook="handleDownloadAudiobook"
          @stop="handleStop"
        >
          <button
            type="button"
            :aria-label="t('monitored.detail.bookMenu', { title: work.title })"
            class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-8"
          >
            <MoreVertical class="size-3.5" />
          </button>
        </MonitoredCardMenu>
      </div>
      <p v-if="subline" class="truncate text-[0.675rem] leading-3.5 text-muted-foreground">{{ subline }}</p>
      <p v-if="seriesLine" class="truncate text-[0.675rem] leading-3.5 text-muted-foreground" data-testid="below-series">{{ seriesLine }}</p>
    </div>
  </article>
</template>
