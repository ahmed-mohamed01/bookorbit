<script setup lang="ts">
import { computed, ref } from 'vue'
import { MoreHorizontal, Pause, Play, Trash2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredBookItem } from '@bookorbit/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { parseMonitoredDate } from '../lib/release-date'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredStatusChip from './MonitoredStatusChip.vue'

const props = defineProps<{ item: MonitoredBookItem; canManage: boolean }>()
const emit = defineEmits<{ pause: [item: MonitoredBookItem]; remove: [item: MonitoredBookItem] }>()
const { t, d } = useI18n()
const imageFailed = ref(false)

const coverUrl = computed(() => toMonitoredCoverUrl(props.item.work.coverUrl))
const fallbackStyle = computed(() => bookCoverStyle(props.item.work.title))
const seriesLine = computed(() => {
  if (!props.item.work.seriesName) return props.item.authorName
  const index = props.item.work.seriesIndex ? ` #${props.item.work.seriesIndex}` : ''
  return `${props.item.authorName} · ${props.item.work.seriesName}${index}`
})
const expectedDate = computed(() => {
  const work = props.item.work
  return work.ebookReleaseDate
    ? parseMonitoredDate(work.ebookReleaseDate, work.ebookDatePrecision)
    : parseMonitoredDate(work.audioReleaseDate, work.audioDatePrecision)
})
const expectedLabel = computed(() => {
  const expected = expectedDate.value
  if (!expected) return t('monitored.common.tba')
  if (expected.precision === 'year') return String(expected.date.getFullYear())
  if (expected.precision === 'month') return d(expected.date, { year: 'numeric', month: 'short' })
  return d(expected.date, { year: 'numeric', month: 'short', day: 'numeric' })
})

function handlePause() {
  emit('pause', props.item)
}

function handleRemove() {
  emit('remove', props.item)
}

function handleImageError() {
  imageFailed.value = true
}
</script>

<template>
  <article class="flex items-center gap-3 rounded-xl border border-border bg-card/75 p-3 sm:gap-4 sm:px-4 sm:py-3.5">
    <div class="relative h-[81px] w-[54px] shrink-0 overflow-hidden rounded shadow-sm" :style="coverUrl && !imageFailed ? undefined : fallbackStyle">
      <img
        v-if="coverUrl && !imageFailed"
        :src="coverUrl"
        :alt="item.work.title"
        class="size-full object-cover"
        loading="lazy"
        @error="handleImageError"
      />
      <span v-else class="flex size-full items-center justify-center p-1 text-center text-[9px] font-bold" :style="{ color: fallbackStyle.color }">
        {{ item.work.title }}
      </span>
    </div>

    <div class="min-w-0 flex-1">
      <h3 class="truncate text-[15px] font-semibold text-foreground">{{ item.work.title }}</h3>
      <p class="mt-0.5 truncate text-xs text-muted-foreground">{{ seriesLine }}</p>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <MonitoredFormatPill v-for="format in item.formats" :key="format" :format="format" />
        <MonitoredFormatPill v-if="!item.formats.includes('audiobook')" format="audiobook" :value="t('monitored.formats.audiobookOff')" muted />
      </div>
      <p class="mt-1.5 text-[11px] text-muted-foreground">{{ t('monitored.books.expected', { date: expectedLabel }) }}</p>
    </div>

    <div class="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
      <MonitoredStatusChip :status="item.paused ? 'paused' : 'monitoring'" />
      <DropdownMenu v-if="canManage">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="t('monitored.books.menu', { title: item.work.title })"
            class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MoreHorizontal :size="16" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem @click="handlePause">
            <Play v-if="item.paused" />
            <Pause v-else />
            {{ item.paused ? t('monitored.actions.resume') : t('monitored.actions.pause') }}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" @click="handleRemove">
            <Trash2 />
            {{ t('monitored.actions.stopMonitoring') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </article>
</template>
