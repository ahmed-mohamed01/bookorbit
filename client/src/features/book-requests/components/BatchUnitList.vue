<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Check, CircleDashed, Loader2, TriangleAlert } from '@lucide/vue'
import type { BatchUnitStatus, BatchUnitView } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'

defineProps<{ units: BatchUnitView[] }>()

const { t } = useI18n()

const STATUS_ICONS = { waiting: CircleDashed, placing: Loader2, in_dock: Check, failed: TriangleAlert } as const

const STATUS_TONES: Record<BatchUnitStatus, string> = {
  waiting: 'text-muted-foreground',
  placing: 'text-info',
  in_dock: 'text-success',
  failed: 'text-destructive',
}

function unitLabel(unit: BatchUnitView): string {
  return unit.title ?? unit.primaryPath
}
</script>

<template>
  <section class="rounded-lg border border-border bg-card p-4" :aria-label="t('bookRequests.batch.units.heading')">
    <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{{ t('bookRequests.batch.units.heading') }}</h3>
    <ul class="divide-y divide-border/60">
      <li v-for="unit in units" :key="unit.unitIndex" class="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div class="min-w-0">
          <p class="line-clamp-2 text-sm break-words text-foreground">{{ unitLabel(unit) }}</p>
          <p v-if="unit.sizeBytes !== null" class="text-xs text-muted-foreground tabular-nums">{{ formatBytes(unit.sizeBytes) }}</p>
          <p v-if="unit.status === 'failed' && unit.errorMessage" class="mt-0.5 line-clamp-2 text-xs break-words text-destructive">
            {{ unit.errorMessage }}
          </p>
        </div>
        <span class="inline-flex shrink-0 items-center gap-1.5 text-xs" :class="STATUS_TONES[unit.status]" :data-status="unit.status">
          <component
            :is="STATUS_ICONS[unit.status]"
            :size="13"
            :class="unit.status === 'placing' && 'animate-spin motion-reduce:animate-none'"
            aria-hidden="true"
          />
          {{ t(`bookRequests.batch.units.status.${unit.status}`) }}
        </span>
      </li>
    </ul>
  </section>
</template>
