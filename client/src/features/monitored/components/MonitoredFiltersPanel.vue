<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  Check,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  CircleDashed,
  TriangleAlert,
  CalendarClock,
  CircleCheck,
  EyeOff,
  CalendarCheck,
  FileQuestion,
  ShieldQuestion,
  Download,
} from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_MARK_KINDS, type MonitoredMarkKind, type MonitoredStatusFilter } from '@bookorbit/types'
import { AUTHOR_STATUS_OPTIONS, isDefaultFilterSelection } from '../lib/status-filter'
import { toggleInOrder } from '../lib/toggle-in-order'
import { toggleKind, type MonitoredDisplayClassCounts, type MonitoredDisplayFlag, type MonitoredDisplayOptions } from '../lib/work-visibility'
import type { MonitoredFilterSection, MonitoredFilterSections } from '../lib/filter-sections'
import { MONITORED_KIND_ICONS } from '../lib/kind-icons'

const props = withDefaults(
  defineProps<{
    modelValue: MonitoredDisplayOptions
    counts: MonitoredDisplayClassCounts
    canCurate: boolean
    statusFilters?: MonitoredStatusFilter[]
    sections: MonitoredFilterSections
    statusOptions?: readonly MonitoredStatusFilter[]
    showRelease?: boolean
  }>(),
  { statusOptions: () => AUTHOR_STATUS_OPTIONS, showRelease: true },
)
const emit = defineEmits<{
  'update:modelValue': [value: MonitoredDisplayOptions]
  'update:statusFilters': [value: MonitoredStatusFilter[]]
  'toggle-section': [key: MonitoredFilterSection]
  reset: []
}>()
const { t } = useI18n()
interface Row {
  key: string
  label: string
  icon: Component
  selected: boolean
  count?: number
}
const statusIcons: Partial<Record<MonitoredStatusFilter, Component>> = {
  missing: CircleDashed,
  needs_attention: TriangleAlert,
  upcoming: CalendarClock,
  in_library: CircleCheck,
  not_watched: EyeOff,
  in_progress: Download,
}
const isDefault = computed(() => isDefaultFilterSelection(props.modelValue, props.statusFilters, props.statusOptions))
function flagRow(key: MonitoredDisplayFlag, icon: Component, count?: number): Row {
  return { key, label: t(`monitored.filters.${key}`), icon, selected: props.modelValue[key], count }
}
function summary(rows: Row[]): string {
  const selected = rows.filter((row) => row.selected)
  if (selected.length === rows.length) return t('monitored.filters.summary.all')
  if (!selected.length) return t('monitored.filters.summary.none')
  if (selected.length <= 2) return selected.map((row) => row.label).join(', ')
  return t('monitored.filters.summary.count', { count: selected.length, total: rows.length })
}
const groups = computed(() => {
  const entries: { key: MonitoredFilterSection; rows: Row[] }[] = []
  if (props.statusFilters)
    entries.push({
      key: 'status',
      rows: props.statusOptions.map((key) => ({
        key,
        label: t(`monitored.statusFilter.options.${key}`),
        icon: statusIcons[key]!,
        selected: props.statusFilters!.includes(key),
      })),
    })
  if (props.showRelease) entries.push({ key: 'release', rows: [flagRow('released', CalendarCheck), flagRow('upcoming', CalendarClock)] })
  entries.push({
    key: 'kind',
    rows: MONITORED_MARK_KINDS.map((key) => ({
      key,
      label: t(`monitored.panel.markAsKinds.${key}.title`),
      icon: MONITORED_KIND_ICONS[key],
      selected: props.modelValue.kinds.includes(key),
      count: props.counts.kinds[key],
    })),
  })
  if (props.canCurate)
    entries.push({
      key: 'more',
      rows: [
        flagRow('hidden', EyeOff, props.counts.hidden),
        flagRow('placeholders', FileQuestion, props.counts.placeholder),
        flagRow('unconfirmed', ShieldQuestion, props.counts.unconfirmed),
      ],
    })
  return entries.map((entry) => ({ ...entry, label: t(`monitored.filters.sections.${entry.key}`), summary: summary(entry.rows) }))
})
function toggleSection(key: MonitoredFilterSection) {
  emit('toggle-section', key)
}
function toggleRow(section: MonitoredFilterSection, key: string) {
  if (section === 'status') {
    if (props.statusFilters) emit('update:statusFilters', toggleInOrder(props.statusOptions, props.statusFilters, key as MonitoredStatusFilter))
  } else if (section === 'kind') {
    emit('update:modelValue', { ...props.modelValue, kinds: toggleKind(props.modelValue.kinds, key as MonitoredMarkKind) })
  } else {
    const flag = key as MonitoredDisplayFlag
    emit('update:modelValue', { ...props.modelValue, [flag]: !props.modelValue[flag] })
  }
}
function reset() {
  emit('reset')
}
</script>

<template>
  <div>
    <section v-for="(group, index) in groups" :key="group.key" :class="index ? 'mt-2 border-t border-border pt-2' : ''">
      <button
        type="button"
        class="flex min-h-8 w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11"
        :aria-expanded="sections[group.key]"
        :data-testid="`section-${group.key}`"
        @click="toggleSection(group.key)"
      >
        <component :is="sections[group.key] ? ChevronDown : ChevronRight" :size="14" aria-hidden="true" />
        <span>{{ group.label }}</span>
        <span v-if="!sections[group.key]" class="ml-auto min-w-0 truncate text-right">{{ group.summary }}</span>
      </button>
      <div v-if="sections[group.key]" role="group" :aria-label="group.label">
        <button
          v-for="row in group.rows"
          :key="row.key"
          type="button"
          role="checkbox"
          :aria-checked="row.selected"
          :data-testid="`${group.key}-${row.key}`"
          class="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11"
          :class="row.selected ? 'text-foreground' : 'text-muted-foreground'"
          @click="toggleRow(group.key, row.key)"
        >
          <component :is="row.icon" :size="16" class="shrink-0" aria-hidden="true" />
          <span class="flex-1 text-left">{{ row.label }}</span>
          <span v-if="row.count !== undefined" class="text-xs text-muted-foreground tabular-nums">{{ row.count }}</span>
          <Check :size="16" class="shrink-0" :class="row.selected ? 'text-primary' : 'invisible'" aria-hidden="true" />
        </button>
      </div>
    </section>
    <div v-if="!isDefault" class="mt-2 border-t border-border pt-2">
      <button
        type="button"
        class="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11"
        data-testid="reset"
        @click="reset"
      >
        <RotateCcw :size="16" aria-hidden="true" />{{ t('monitored.filters.reset') }}
      </button>
    </div>
  </div>
</template>
