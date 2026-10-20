<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WebSerialPrintDownload } from '@bookorbit/types'
const props = defineProps<{ downloads: WebSerialPrintDownload[] }>()
const { t } = useI18n()
const SETTLED = ['filed', 'failed', 'held'] as const
type SettledStatus = (typeof SETTLED)[number]
function isSettled(status: WebSerialPrintDownload['status']): status is SettledStatus {
  return (SETTLED as readonly string[]).includes(status)
}
// A row whose file names named no volume still stands for one.
function volumeCount(rows: WebSerialPrintDownload[]) {
  return new Set(rows.flatMap((row) => row.volumes)).size + rows.filter((row) => !row.volumes.length).length
}
const heading = computed(() => {
  const active = props.downloads.filter((row) => !isSettled(row.status))
  if (active.length) return t('webSerials.acquisition.downloading', volumeCount(active))
  const summary = SETTLED.flatMap((status) => {
    const count = volumeCount(props.downloads.filter((row) => row.status === status))
    return count ? [t(`webSerials.acquisition.finishedCount.${status}`, count)] : []
  }).join(', ')
  return t('webSerials.acquisition.finished', { summary })
})
function percent(row: WebSerialPrintDownload) {
  return Math.max(0, Math.min(100, row.percent ?? (row.status === 'filed' || row.status === 'filing' ? 100 : 0)))
}
</script>
<template>
  <section v-if="downloads.length" class="space-y-3 rounded-xl border border-warning/40 bg-warning/10 p-4" aria-live="polite">
    <h3 class="text-sm font-semibold">{{ heading }}</h3>
    <div v-for="row in downloads" :key="row.key" class="space-y-1.5">
      <div class="flex justify-between gap-3 text-xs">
        <span>{{ row.title }}</span
        ><span class="text-muted-foreground">{{
          row.status === 'downloading' && row.percent !== null ? `${percent(row)}%` : t(`webSerials.acquisition.progress.${row.status}`)
        }}</span>
      </div>
      <div
        role="progressbar"
        :aria-label="row.title"
        :aria-valuenow="row.percent === null ? undefined : percent(row)"
        :aria-valuemin="0"
        :aria-valuemax="100"
        class="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          class="h-full rounded-full"
          :class="
            row.status === 'failed' ? 'bg-destructive' : row.status === 'filed' ? 'bg-success' : row.status === 'filing' ? 'bg-info' : 'bg-warning'
          "
          :style="{ width: `${percent(row)}%` }"
        />
      </div>
      <p v-if="row.error" class="text-xs text-destructive">{{ row.error }}</p>
    </div>
  </section>
</template>
