<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const MAX_TICKS = 40

const props = defineProps<{ samplesDone: number | null; samplesTotal: number | null }>()

const { t } = useI18n()

const tickStrip = computed(() => {
  const total = props.samplesTotal
  if (typeof total !== 'number' || total <= 0) return null
  const count = Math.min(MAX_TICKS, total)
  const done = Math.min(total, Math.max(0, props.samplesDone ?? 0))
  const doneTicks = Math.floor((done / total) * count)
  const ticks = Array.from({ length: count }, (_, index) => {
    if (index < doneTicks) return 'bg-info'
    if (index === doneTicks) return 'animate-pulse bg-info/50'
    return 'bg-muted'
  })
  // With every sample done (a resumed, already complete alignment, or the final map-building pass) or
  // no count yet, there is no current tick to pulse, so the whole strip pulses to show work continues.
  return { ticks, pulsing: props.samplesDone === null || doneTicks >= count }
})

const progressPercent = computed(() => {
  const total = props.samplesTotal
  if (typeof total !== 'number' || total <= 0) return undefined
  return Math.round((Math.max(0, Math.min(total, props.samplesDone ?? 0)) / total) * 100)
})
</script>

<template>
  <div
    v-if="tickStrip"
    class="flex gap-0.5"
    :class="{ 'animate-pulse': tickStrip.pulsing }"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="progressPercent"
    :aria-label="t('book.detail.readingAlignment.progressLabel')"
    data-testid="position-sync-ticks"
  >
    <div
      v-for="(tickClass, index) in tickStrip.ticks"
      :key="index"
      class="h-3.5 flex-1 rounded-[2px] transition-colors duration-500"
      :class="tickClass"
      data-testid="position-sync-tick"
    />
  </div>
  <div
    v-else
    class="h-1.5 w-full animate-pulse rounded-full bg-info/40"
    role="progressbar"
    :aria-label="t('book.detail.readingAlignment.progressLabel')"
    data-testid="position-sync-indeterminate"
  />
</template>
