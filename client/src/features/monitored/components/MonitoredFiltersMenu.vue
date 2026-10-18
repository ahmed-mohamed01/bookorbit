<script setup lang="ts">
import { computed } from 'vue'
import { SlidersHorizontal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { MonitoredStatusFilter } from '@bookorbit/types'
import MonitoredFiltersPanel from './MonitoredFiltersPanel.vue'
import type { MonitoredFilterSection, MonitoredFilterSections } from '../lib/filter-sections'
import { isDefaultAuthorFilters } from '../lib/status-filter'
import type { MonitoredDisplayClassCounts, MonitoredDisplayOptions } from '../lib/work-visibility'

const props = defineProps<{
  modelValue: MonitoredDisplayOptions
  counts: MonitoredDisplayClassCounts
  sections: MonitoredFilterSections
  canCurate: boolean
  statusFilters?: MonitoredStatusFilter[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: MonitoredDisplayOptions]
  'update:statusFilters': [value: MonitoredStatusFilter[]]
  'toggle-section': [key: MonitoredFilterSection]
  reset: []
}>()

const { t } = useI18n()

const isDefault = computed(() => isDefaultAuthorFilters(props.modelValue, props.statusFilters))

function updateStatus(value: MonitoredStatusFilter[]) {
  emit('update:statusFilters', value)
}

function update(value: MonitoredDisplayOptions) {
  emit('update:modelValue', value)
}

function toggleSection(key: MonitoredFilterSection) {
  emit('toggle-section', key)
}

function reset() {
  emit('reset')
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors"
        :class="
          isDefault
            ? 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
            : 'border-primary/55 bg-primary/10 text-primary'
        "
        :aria-label="t('monitored.filters.title')"
        :title="t('monitored.filters.title')"
      >
        <SlidersHorizontal :size="13" />
        <span class="hidden lg:inline">{{ t('monitored.filters.title') }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="max-h-(--reka-popover-content-available-height) w-64 max-w-[calc(100vw-2rem)] overflow-y-auto p-2">
      <MonitoredFiltersPanel
        :model-value="modelValue"
        :counts="counts"
        :sections="sections"
        :can-curate="canCurate"
        :status-filters="statusFilters"
        @toggle-section="toggleSection"
        @update:status-filters="updateStatus"
        @update:model-value="update"
        @reset="reset"
      />
    </PopoverContent>
  </Popover>
</template>
