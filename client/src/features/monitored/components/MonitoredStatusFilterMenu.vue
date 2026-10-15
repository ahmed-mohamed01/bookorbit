<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ListFilter, RotateCcw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_STATUS_FILTERS, type MonitoredStatusFilter } from '@bookorbit/types'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { defaultStatusFilters, isDefaultStatusFilters, isSameStatusSelection, toggleStatusFilter } from '../lib/status-filter'

const props = withDefaults(
  defineProps<{
    modelValue: MonitoredStatusFilter[]
    /** The states this page offers; a page with its own control for hidden works leaves that one out. */
    options?: readonly MonitoredStatusFilter[]
  }>(),
  { options: () => MONITORED_STATUS_FILTERS },
)
const emit = defineEmits<{ 'update:modelValue': [value: MonitoredStatusFilter[]] }>()

const { t } = useI18n()

/** Ticks edit a draft, and the list reloads once when the menu closes rather than on every box. */
const draft = ref<MonitoredStatusFilter[]>([...props.modelValue])
const menuOpen = ref(false)

watch(
  () => props.modelValue,
  (value) => {
    if (!menuOpen.value) draft.value = [...value]
  },
)

const isDefault = computed(() => isDefaultStatusFilters(draft.value))
const label = computed(() => t('monitored.statusFilter.label'))

function isSelected(filter: MonitoredStatusFilter): boolean {
  return draft.value.includes(filter)
}

function toggle(filter: MonitoredStatusFilter) {
  draft.value = toggleStatusFilter(draft.value, filter)
}

function handleOpenChange(open: boolean) {
  menuOpen.value = open
  if (open) {
    draft.value = [...props.modelValue]
    return
  }
  if (!isSameStatusSelection(draft.value, props.modelValue)) emit('update:modelValue', [...draft.value])
}

/** Ticking a box keeps the menu open, so several states can be picked in one visit. */
function keepOpen(event: Event) {
  event.preventDefault()
}

function reset() {
  draft.value = defaultStatusFilters()
}
</script>

<template>
  <DropdownMenu @update:open="handleOpenChange">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors"
        :class="
          isDefault
            ? 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
            : 'border-primary/55 bg-primary/10 text-primary'
        "
        :aria-label="label"
        :title="label"
        data-testid="status-filter"
      >
        <ListFilter :size="13" />
        <span class="hidden lg:inline">{{ label }}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-64">
      <DropdownMenuLabel class="text-xs text-muted-foreground">{{ t('monitored.statusFilter.title') }}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        v-for="filter in options"
        :key="filter"
        :model-value="isSelected(filter)"
        :disabled="isSelected(filter) && draft.length === 1"
        @select="keepOpen"
        @update:model-value="toggle(filter)"
      >
        <span class="flex min-w-0 flex-col">
          <span class="text-sm">{{ t(`monitored.statusFilter.options.${filter}`) }}</span>
          <span class="text-[11px] text-muted-foreground">{{ t(`monitored.statusFilter.hints.${filter}`) }}</span>
        </span>
      </DropdownMenuCheckboxItem>
      <template v-if="!isDefault">
        <DropdownMenuSeparator />
        <DropdownMenuItem @click="reset">
          <RotateCcw />
          {{ t('monitored.statusFilter.reset') }}
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
