<script setup lang="ts">
import { Check, Circle, Clock3, Download, FolderInput, TriangleAlert } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredReleaseStatus, MonitoredWorkState } from '@bookorbit/types'

defineProps<{ status: MonitoredWorkState | MonitoredReleaseStatus }>()
const { t } = useI18n()
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap"
    :class="{
      'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]': status === 'monitoring' || status === 'available',
      'border-border bg-muted text-muted-foreground': status === 'paused' || status === 'upcoming',
      'border-[var(--pill-pending)]/40 bg-[var(--pill-pending)]/10 text-[var(--pill-pending)]': status === 'queued',
      'border-primary/40 bg-primary/10 text-primary': status === 'downloading' || status === 'moving',
      'border-[var(--pill-warning)]/40 bg-[var(--pill-warning)]/10 text-[var(--pill-warning)]': status === 'needs_review',
      'border-[var(--pill-success)]/40 bg-[var(--pill-success)]/10 text-[var(--pill-success)]': status === 'grabbed',
    }"
  >
    <Check v-if="status === 'grabbed'" :size="11" />
    <Clock3 v-else-if="status === 'upcoming'" :size="11" />
    <Download v-else-if="status === 'downloading'" :size="11" />
    <FolderInput v-else-if="status === 'moving'" :size="11" />
    <TriangleAlert v-else-if="status === 'needs_review'" :size="11" />
    <Circle v-else :size="8" fill="currentColor" />
    {{ t(`monitored.status.${status}`) }}
  </span>
</template>
