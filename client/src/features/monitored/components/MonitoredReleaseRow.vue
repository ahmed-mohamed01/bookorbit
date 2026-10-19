<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLongPress } from '@vueuse/core'
import { Check, Download } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat, MonitoredReleaseItem, TableDensity } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import BookCoverPlaceholder from '@/features/book/components/BookCoverPlaceholder.vue'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { parseMonitoredDate } from '../lib/release-date'
import { daysUntil, workFormatStatus } from '../lib/format-status'
import { relativeReleaseLabel } from '../lib/time-badge'
import MonitoredReasonChips from './MonitoredReasonChips.vue'
import { reviewReasons } from '../lib/review-reasons'
import MonitoredFormatStatusChip from './MonitoredFormatStatusChip.vue'

const props = withDefaults(
  defineProps<{
    item: MonitoredReleaseItem
    canManage: boolean
    requesting?: boolean
    density?: TableDensity
    selectionMode?: boolean
    selected?: boolean
    /** Has something left to act on; a row that does not is dimmed and cannot be picked. */
    selectable?: boolean
    /** A long press starts select mode with this row picked. */
    longPressSelect?: boolean
  }>(),
  { density: 'comfortable', selectable: true },
)
const emit = defineEmits<{
  request: [item: MonitoredReleaseItem]
  preview: [item: MonitoredReleaseItem]
  select: [item: MonitoredReleaseItem, event: MouseEvent]
  longPress: [item: MonitoredReleaseItem]
}>()
const { t, d, te } = useI18n()
const imageFailed = ref(false)

const DENSITY_CLASSES: Record<TableDensity, { row: string; date: string; day: string; cover: string }> = {
  compact: { row: 'gap-2 p-1.5 sm:gap-3 sm:px-3', date: 'w-9 pr-2', day: 'text-base', cover: 'h-[42px] w-[28px]' },
  comfortable: { row: 'gap-3 p-3 sm:gap-4 sm:px-4', date: 'w-11 pr-3', day: 'text-xl', cover: 'h-[63px] w-[42px]' },
  roomy: { row: 'gap-4 p-4 sm:gap-5 sm:px-5', date: 'w-12 pr-3', day: 'text-2xl', cover: 'h-[78px] w-[52px]' },
}
const classes = computed(() => DENSITY_CLASSES[props.density])
const date = computed(() => parseMonitoredDate(props.item.releaseDate)?.date ?? null)
const day = computed(() => (date.value ? String(date.value.getDate()).padStart(2, '0') : '-'))
const month = computed(() => (date.value ? d(date.value, { month: 'short' }).toUpperCase() : ''))
const reasons = computed(() => reviewReasons(props.item.work, t, te))
const coverUrl = computed(() => toMonitoredCoverUrl(props.item.coverUrl))
const placeholderAuthors = computed(() => [props.item.authorName])
const relativeTime = computed(() => {
  if (!date.value) return null
  return relativeReleaseLabel(daysUntil(date.value), t)
})

/** The row's own format leads; the other one follows so the row reads like the card. */
const formats = computed<MonitoredFormat[]>(() => (props.item.format === 'ebook' ? ['ebook', 'audiobook'] : ['audiobook', 'ebook']))

function statusOf(format: MonitoredFormat) {
  const mode = props.item.authorModes?.[format]
  return workFormatStatus(props.item.work, format, {
    authorWatches: mode === undefined || mode !== 'off',
    optimisticQueued: format === props.item.format && props.requesting,
  })
}

const rowStatus = computed(() => statusOf(props.item.format))
const canRequest = computed(() => props.canManage && rowStatus.value === 'missing' && !props.selectionMode)
const openLabel = computed(() => {
  if (!props.selectionMode) return undefined
  return t(props.selected ? 'monitored.selection.card.deselect' : 'monitored.selection.card.select', { title: props.item.title })
})

function handleRequest() {
  emit('request', props.item)
}

const openButton = ref<HTMLButtonElement | null>(null)
// The release of a long press lands on the row as a click, which must not also toggle the row it just
// picked. Touch browsers often send no click at all, so the swallow only holds briefly.
const LONG_PRESS_SWALLOW_WINDOW_MS = 300
let longPressPendingRelease = false
let longPressReleasedAt: number | null = null

function handleLongPress() {
  if (!props.longPressSelect || props.selectionMode || !props.selectable) return
  longPressPendingRelease = true
  emit('longPress', props.item)
}

function handleLongPressRelease(_duration: number, _distance: number, isLongPress: boolean) {
  if (isLongPress && longPressPendingRelease) longPressReleasedAt = Date.now()
  longPressPendingRelease = false
}

onLongPress(openButton, handleLongPress, { delay: 500, onMouseUp: handleLongPressRelease })

function handlePreview(event: MouseEvent) {
  const swallowReleaseClick = longPressReleasedAt !== null && Date.now() - longPressReleasedAt <= LONG_PRESS_SWALLOW_WINDOW_MS
  longPressReleasedAt = null
  if (swallowReleaseClick) return
  if (!props.selectionMode) emit('preview', props.item)
  else if (props.selectable) emit('select', props.item, event)
}

function handleContextmenu(event: MouseEvent) {
  if (props.longPressSelect) event.preventDefault()
}

function handleImageError() {
  imageFailed.value = true
}
</script>

<template>
  <article
    class="relative flex items-center rounded-xl border focus-within:ring-2 focus-within:ring-ring"
    :class="[
      classes.row,
      selectionMode && selected ? 'border-primary/60 bg-primary/10' : 'border-border bg-card/75',
      selectionMode && !selectable ? 'opacity-50' : '',
    ]"
    :data-selected="selectionMode ? Boolean(selected) : undefined"
  >
    <span
      v-if="selectionMode"
      class="flex size-5 shrink-0 items-center justify-center rounded-xs border"
      :class="
        selected ? 'border-primary bg-primary text-primary-foreground' : selectable ? 'border-border bg-background' : 'border-dashed border-border'
      "
      aria-hidden="true"
      data-testid="release-row-check"
    >
      <Check v-if="selected" :size="12" />
    </span>
    <div class="shrink-0 border-r border-border text-center" :class="classes.date">
      <div class="font-extrabold tabular-nums text-foreground" :class="classes.day">{{ day }}</div>
      <div class="text-[10px] font-bold tracking-wide text-muted-foreground">{{ month }}</div>
    </div>
    <div class="relative shrink-0 overflow-hidden rounded shadow-sm" :class="classes.cover">
      <img
        v-if="coverUrl && !imageFailed"
        :src="coverUrl"
        :alt="item.title"
        class="size-full object-cover"
        loading="lazy"
        @error="handleImageError"
      />
      <BookCoverPlaceholder
        v-else
        :title="item.title"
        :subtitle="item.work.subtitle"
        :authors="placeholderAuthors"
        :series-name="item.work.seriesName"
        :series-index="item.work.seriesIndex"
        :is-audio="item.format === 'audiobook'"
        :seed="item.title"
      />
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="truncate text-sm font-semibold text-foreground">
        <button
          type="button"
          class="max-w-full truncate text-start after:absolute after:inset-0 after:content-[''] hover:text-primary focus-visible:outline-none"
          :disabled="selectionMode && !selectable"
          :aria-pressed="selectionMode ? Boolean(selected) : undefined"
          :aria-label="openLabel"
          ref="openButton"
          data-testid="release-row-open"
          :class="longPressSelect ? '[-webkit-touch-callout:none] select-none' : undefined"
          @click="handlePreview"
          @contextmenu="handleContextmenu"
        >
          {{ item.title }}
        </button>
      </h3>
      <p class="truncate text-xs text-muted-foreground">{{ item.authorName }}</p>
      <MonitoredReasonChips :reasons="reasons" text-size="sm" class="mt-1" />
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <MonitoredFormatStatusChip
          v-for="format in formats"
          :key="format"
          :work="item.work"
          :format="format"
          :status="statusOf(format)"
          :mode="item.authorModes?.[format] ?? null"
        />
        <span v-if="relativeTime" class="text-[11px] text-muted-foreground">{{ relativeTime }}</span>
      </div>
    </div>
    <div v-if="canRequest" class="relative z-10 flex w-auto shrink-0 justify-end sm:w-40">
      <Button size="sm" :disabled="requesting" class="hidden sm:inline-flex" @click="handleRequest">
        <Download :size="14" />
        {{ t('monitored.releases.getAutomatically') }}
      </Button>
      <Button size="icon-sm" :disabled="requesting" class="sm:hidden" :aria-label="t('monitored.releases.getAutomatically')" @click="handleRequest">
        <Download :size="14" />
      </Button>
    </div>
  </article>
</template>
