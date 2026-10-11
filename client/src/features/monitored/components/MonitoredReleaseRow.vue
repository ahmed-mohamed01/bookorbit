<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredReleaseItem, TableDensity } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { parseMonitoredDate } from '../lib/release-date'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredStatusChip from './MonitoredStatusChip.vue'

const props = withDefaults(defineProps<{ item: MonitoredReleaseItem; canManage: boolean; requesting?: boolean; density?: TableDensity }>(), {
  density: 'comfortable',
})
const emit = defineEmits<{ request: [item: MonitoredReleaseItem] }>()
const { t, d } = useI18n()
const imageFailed = ref(false)

const DENSITY_CLASSES: Record<TableDensity, { row: string; date: string; day: string; cover: string }> = {
  compact: { row: 'gap-2 p-1.5 sm:gap-3 sm:px-3', date: 'w-9 pr-2', day: 'text-base', cover: 'h-[42px] w-[28px]' },
  comfortable: { row: 'gap-3 p-3 sm:gap-4 sm:px-4', date: 'w-11 pr-3', day: 'text-xl', cover: 'h-[63px] w-[42px]' },
  roomy: { row: 'gap-4 p-4 sm:gap-5 sm:px-5', date: 'w-12 pr-3', day: 'text-2xl', cover: 'h-[78px] w-[52px]' },
}
const classes = computed(() => DENSITY_CLASSES[props.density])
const date = computed(() => parseMonitoredDate(props.item.releaseDate)?.date ?? null)
const day = computed(() => (date.value ? String(date.value.getDate()).padStart(2, '0') : ''))
const month = computed(() => (date.value ? d(date.value, { month: 'short' }).toUpperCase() : ''))
const coverUrl = computed(() => toMonitoredCoverUrl(props.item.coverUrl))
const fallbackStyle = computed(() => bookCoverStyle(props.item.title))
const relativeTime = computed(() => {
  if (!date.value) return null
  const days = Math.round((date.value.getTime() - Date.now()) / 86_400_000)
  if (days === 0) return t('monitored.releases.today')
  return days > 0 ? t('monitored.releases.inDays', { count: days }) : t('monitored.releases.daysAgo', { count: Math.abs(days) })
})

function handleRequest() {
  emit('request', props.item)
}

function handleImageError() {
  imageFailed.value = true
}
</script>

<template>
  <article class="flex items-center rounded-xl border border-border bg-card/75" :class="classes.row">
    <div class="shrink-0 border-r border-border text-center" :class="classes.date">
      <div class="font-extrabold tabular-nums text-foreground" :class="classes.day">{{ day }}</div>
      <div class="text-[10px] font-bold tracking-wide text-muted-foreground">{{ month }}</div>
    </div>
    <div
      class="relative shrink-0 overflow-hidden rounded shadow-sm"
      :class="classes.cover"
      :style="coverUrl && !imageFailed ? undefined : fallbackStyle"
    >
      <img
        v-if="coverUrl && !imageFailed"
        :src="coverUrl"
        :alt="item.title"
        class="size-full object-cover"
        loading="lazy"
        @error="handleImageError"
      />
      <span v-else class="flex size-full items-center justify-center p-1 text-center text-[8px] font-bold" :style="{ color: fallbackStyle.color }">{{
        item.title
      }}</span>
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="truncate text-sm font-semibold text-foreground">{{ item.title }}</h3>
      <p class="truncate text-xs text-muted-foreground">{{ item.authorName }}</p>
      <div class="mt-1.5 flex flex-wrap items-center gap-2">
        <MonitoredFormatPill :format="item.format" />
        <span v-if="relativeTime" class="text-[11px] text-muted-foreground">{{ relativeTime }}</span>
      </div>
    </div>
    <div class="flex w-auto shrink-0 justify-end sm:w-40">
      <template v-if="canManage && item.status === 'available'">
        <Button size="sm" :disabled="requesting" class="hidden sm:inline-flex" @click="handleRequest">
          <Download :size="14" />
          {{ t('monitored.releases.getAutomatically') }}
        </Button>
        <Button size="icon-sm" :disabled="requesting" class="sm:hidden" :aria-label="t('monitored.releases.getAutomatically')" @click="handleRequest">
          <Download :size="14" />
        </Button>
      </template>
      <MonitoredStatusChip v-else :status="item.status" />
    </div>
  </article>
</template>
