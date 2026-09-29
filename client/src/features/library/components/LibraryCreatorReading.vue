<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { formatNumber, formatPercent } from '@/i18n/formatters'

const { t } = useI18n()

defineProps<{
  readingThreshold: number
  markAsFinishedPercentComplete: number
}>()

const emit = defineEmits<{
  'update:readingThreshold': [value: number]
  'update:markAsFinishedPercentComplete': [value: number]
}>()

function onReadingThresholdInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  if (!isNaN(val)) emit('update:readingThreshold', val)
}

function onFinishPercentInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  if (!isNaN(val)) emit('update:markAsFinishedPercentComplete', val)
}

function formatFinishedThreshold(value: number): string {
  return formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 2 })
}
</script>

<template>
  <div class="px-6 py-6 space-y-6">
    <!-- Reading start -->
    <div>
      <div class="flex items-center justify-between mb-1">
        <label for="reading-threshold" class="text-[11px] font-semibold uppercase tracking-widest text-foreground">
          {{ t('library.creator.reading.readingStart.title') }}
        </label>
        <output for="reading-threshold" class="text-sm font-medium text-foreground tabular-nums">{{ readingThreshold }}%</output>
      </div>
      <p id="reading-threshold-help" class="text-xs text-muted-foreground mb-3">
        {{ t('library.creator.reading.readingStart.hint') }}
      </p>
      <input
        id="reading-threshold"
        type="range"
        :value="readingThreshold"
        min="0.05"
        max="5"
        step="0.05"
        class="w-full accent-primary"
        aria-describedby="reading-threshold-help"
        @input="onReadingThresholdInput"
      />
      <div class="flex justify-between text-xs text-muted-foreground mt-1">
        <span>0.05%</span>
        <span>5%</span>
      </div>
    </div>

    <!-- Mark as finished -->
    <div>
      <div class="flex items-center justify-between mb-1">
        <label for="finished-threshold" class="text-[11px] font-semibold uppercase tracking-widest text-foreground">
          {{ t('library.creator.reading.markAsFinished.title') }}
        </label>
        <output for="finished-threshold" class="text-sm font-medium text-foreground tabular-nums">
          {{ formatFinishedThreshold(markAsFinishedPercentComplete) }}
        </output>
      </div>
      <p id="finished-threshold-help" class="text-xs text-muted-foreground mb-3">
        {{ t('library.creator.reading.markAsFinished.hint') }}
      </p>
      <input
        id="finished-threshold"
        type="range"
        :value="markAsFinishedPercentComplete"
        min="90"
        max="100"
        step="0.05"
        class="w-full accent-primary"
        aria-describedby="finished-threshold-help"
        @input="onFinishPercentInput"
      />
      <div class="flex justify-between text-xs text-muted-foreground mt-1">
        <span>{{ formatPercent(0.9) }}</span>
        <span>{{ formatPercent(1) }}</span>
      </div>
    </div>
  </div>
</template>
