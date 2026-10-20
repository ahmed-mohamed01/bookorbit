<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WebSerialPrintDownload } from '@bookorbit/types'
const props = defineProps<{ downloads: WebSerialPrintDownload[] }>()
const { t } = useI18n()
const count = computed(() => new Set(props.downloads.flatMap((row) => row.volumes)).size)
function percent(row: WebSerialPrintDownload) {
  return Math.max(0, Math.min(100, row.percent ?? (row.status === 'filed' || row.status === 'filing' ? 100 : 0)))
}
</script>
<template>
  <section v-if="downloads.length" class="space-y-3 rounded-xl border border-warning/40 bg-warning/10 p-4" aria-live="polite">
    <h3 class="text-sm font-semibold">{{ t('webSerials.acquisition.downloading', count) }}</h3>
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
