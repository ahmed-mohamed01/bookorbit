<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'
import { ArrowUpDown } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import MonitoredSortOptions from './MonitoredSortOptions.vue'

type SortOrder = 'asc' | 'desc'

interface SortOption {
  value: T
  label: string
}

const props = defineProps<{
  options: readonly SortOption[]
  modelValue: T
  order: SortOrder
  defaultValue?: T
  defaultOrder?: SortOrder
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T]; 'update:order': [value: SortOrder] }>()

const { t } = useI18n()

const selectedLabel = computed(() => props.options.find((option) => option.value === props.modelValue)?.label ?? '')
const orderLabel = computed(() => (props.order === 'asc' ? t('monitored.detail.controls.ascending') : t('monitored.detail.controls.descending')))
const summary = computed(() => `${selectedLabel.value} · ${orderLabel.value}`)
const isDefault = computed(
  () =>
    props.defaultValue === undefined ||
    (props.modelValue === props.defaultValue && (props.defaultOrder === undefined || props.order === props.defaultOrder)),
)

function selectField(value: T) {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

function selectOrder(value: SortOrder) {
  if (value !== props.order) emit('update:order', value)
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
        :aria-label="t('monitored.detail.controls.sort')"
        :title="summary"
      >
        <ArrowUpDown :size="13" />
        <span class="hidden lg:inline">{{ selectedLabel }}</span>
        <span class="lg:hidden">{{ t('monitored.detail.controls.sort') }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-56 p-2">
      <MonitoredSortOptions
        :options="options"
        :model-value="modelValue"
        :order="order"
        @update:model-value="selectField"
        @update:order="selectOrder"
      />
    </PopoverContent>
  </Popover>
</template>
