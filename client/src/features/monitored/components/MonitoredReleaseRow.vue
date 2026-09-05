<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredReleaseItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { parseMonitoredDate } from '../lib/release-date'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredStatusChip from './MonitoredStatusChip.vue'

const props = defineProps<{ item: MonitoredReleaseItem; canManage: boolean; requesting?: boolean }>()
const emit = defineEmits<{ request: [item: MonitoredReleaseItem] }>()
const { t, d } = useI18n()
const imageFailed = ref(false)

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
  <article class="flex items-center gap-3 rounded-xl border border-border bg-card/75 p-3 sm:gap-4 sm:px-4">
    <div class="w-11 shrink-0 border-r border-border pr-3 text-center">
      <div class="text-xl font-extrabold tabular-nums text-foreground">{{ day }}</div>
      <div class="text-[10px] font-bold tracking-wide text-muted-foreground">{{ month }}</div>
    </div>
    <div class="relative h-[63px] w-[42px] shrink-0 overflow-hidden rounded shadow-sm" :style="coverUrl && !imageFailed ? undefined : fallbackStyle">
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
