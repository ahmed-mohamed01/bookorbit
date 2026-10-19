<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SlidersHorizontal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { MonitoredStatusFilter } from '@bookorbit/types'
import MonitoredFiltersPanel from './MonitoredFiltersPanel.vue'
import type { MonitoredFilterSection, MonitoredFilterSections } from '../lib/filter-sections'
import { AUTHOR_STATUS_OPTIONS, defaultAuthorStatusFilters, defaultStatusFilters, isDefaultFilterSelection } from '../lib/status-filter'
import { DEFAULT_MONITORED_DISPLAY, type MonitoredDisplayClassCounts, type MonitoredDisplayOptions } from '../lib/work-visibility'

const props = withDefaults(
  defineProps<{
    modelValue: MonitoredDisplayOptions
    counts: MonitoredDisplayClassCounts
    sections: MonitoredFilterSections
    canCurate: boolean
    statusFilters?: MonitoredStatusFilter[]
    statusOptions?: readonly MonitoredStatusFilter[]
    showRelease?: boolean
    /** Ticks edit a draft and the parent hears of them once, when the popover closes. */
    commitOnClose?: boolean
  }>(),
  { statusOptions: () => AUTHOR_STATUS_OPTIONS, showRelease: true, commitOnClose: false },
)
const emit = defineEmits<{
  'update:modelValue': [value: MonitoredDisplayOptions]
  'update:statusFilters': [value: MonitoredStatusFilter[]]
  'toggle-section': [key: MonitoredFilterSection]
  'open-change': [open: boolean]
  reset: []
}>()

const { t } = useI18n()

const open = ref(false)
const draftDisplay = ref<MonitoredDisplayOptions>({ ...props.modelValue })
const draftStatus = ref<MonitoredStatusFilter[] | undefined>(props.statusFilters && [...props.statusFilters])

watch(
  () => [props.modelValue, props.statusFilters] as const,
  ([display, status]) => {
    if (open.value && props.commitOnClose) return
    draftDisplay.value = { ...display }
    draftStatus.value = status && [...status]
  },
)

const shownDisplay = computed(() => (props.commitOnClose ? draftDisplay.value : props.modelValue))
const shownStatus = computed(() => (props.commitOnClose ? draftStatus.value : props.statusFilters))
const isDefault = computed(() => isDefaultFilterSelection(props.modelValue, props.statusFilters, props.statusOptions))

function sameStatus(a: readonly MonitoredStatusFilter[] | undefined, b: readonly MonitoredStatusFilter[] | undefined): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((entry) => b.includes(entry)))
}

function sameDisplay(a: MonitoredDisplayOptions, b: MonitoredDisplayOptions): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function updateStatus(value: MonitoredStatusFilter[]) {
  if (props.commitOnClose) {
    // The releases tab never lists by no status at all, so the last tick stays.
    if (value.length) draftStatus.value = value
  } else emit('update:statusFilters', value)
}

function update(value: MonitoredDisplayOptions) {
  if (props.commitOnClose) draftDisplay.value = value
  else emit('update:modelValue', value)
}

function handleOpenChange(next: boolean) {
  open.value = next
  emit('open-change', next)
  if (next) {
    draftDisplay.value = { ...props.modelValue }
    draftStatus.value = props.statusFilters && [...props.statusFilters]
    return
  }
  if (!props.commitOnClose) return
  if (draftStatus.value && !sameStatus(draftStatus.value, props.statusFilters)) emit('update:statusFilters', draftStatus.value)
  if (!sameDisplay(draftDisplay.value, props.modelValue)) emit('update:modelValue', draftDisplay.value)
}

function toggleSection(key: MonitoredFilterSection) {
  emit('toggle-section', key)
}

function reset() {
  if (props.commitOnClose) {
    draftDisplay.value = { ...DEFAULT_MONITORED_DISPLAY }
    if (draftStatus.value) draftStatus.value = props.statusOptions.includes('in_progress') ? defaultStatusFilters() : defaultAuthorStatusFilters()
    return
  }
  emit('reset')
}
</script>

<template>
  <Popover @update:open="handleOpenChange">
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
        :model-value="shownDisplay"
        :counts="counts"
        :sections="sections"
        :can-curate="canCurate"
        :status-filters="shownStatus"
        :status-options="statusOptions"
        :show-release="showRelease"
        @toggle-section="toggleSection"
        @update:status-filters="updateStatus"
        @update:model-value="update"
        @reset="reset"
      />
    </PopoverContent>
  </Popover>
</template>
