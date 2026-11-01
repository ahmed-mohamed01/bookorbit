<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { MonitoredReleaseFilter, MonitoredReleaseTiming } from '@bookorbit/types'
import { releaseFilterFitsTiming } from '../lib/release-view'

const props = defineProps<{ modelValue: MonitoredReleaseFilter; timing: MonitoredReleaseTiming }>()
const emit = defineEmits<{ 'update:modelValue': [value: MonitoredReleaseFilter] }>()
const { t } = useI18n()

const allOptions: { id: MonitoredReleaseFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'monitored.controlsBar.filterAll' },
  { id: 'recent', labelKey: 'monitored.controlsBar.filterRecent' },
  { id: 'soon', labelKey: 'monitored.controlsBar.filterSoon' },
  { id: 'year', labelKey: 'monitored.controlsBar.filterYear' },
]
const options = computed(() => allOptions.filter((option) => releaseFilterFitsTiming(option.id, props.timing)))

function select(filter: MonitoredReleaseFilter) {
  emit('update:modelValue', filter)
}
</script>

<template>
  <div class="no-scrollbar flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-muted p-0.5" role="group" :aria-label="t('monitored.controlsBar.filter')">
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="h-7 shrink-0 rounded-md px-2.5 text-xs font-semibold transition-colors"
      :class="modelValue === option.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
      :aria-pressed="modelValue === option.id"
      @click="select(option.id)"
    >
      {{ t(option.labelKey) }}
    </button>
  </div>
</template>
