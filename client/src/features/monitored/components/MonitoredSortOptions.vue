<script setup lang="ts" generic="T extends string">
import { useI18n } from 'vue-i18n'

type SortOrder = 'asc' | 'desc'

interface SortOption {
  value: T
  label: string
}

const props = defineProps<{
  options: readonly SortOption[]
  modelValue: T
  order: SortOrder
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T]; 'update:order': [value: SortOrder] }>()

const { t } = useI18n()

const ORDERS: readonly SortOrder[] = ['asc', 'desc']

function selectField(value: T) {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

function selectOrder(value: SortOrder) {
  if (value !== props.order) emit('update:order', value)
}
</script>

<template>
  <div>
    <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">{{ t('monitored.detail.controls.sort') }}</div>
    <div class="flex flex-col gap-0.5" role="radiogroup" :aria-label="t('monitored.detail.controls.sort')">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="option.value === modelValue"
        class="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="option.value === modelValue ? 'font-medium text-foreground' : 'text-muted-foreground'"
        @click="selectField(option.value)"
      >
        {{ option.label }}
        <span v-if="option.value === modelValue" class="text-xs text-primary" aria-hidden="true">{{ order === 'asc' ? '↑' : '↓' }}</span>
      </button>
    </div>
    <div class="my-2 border-t border-border" />
    <div class="flex gap-1" role="radiogroup" :aria-label="t('monitored.detail.controls.order')">
      <button
        v-for="direction in ORDERS"
        :key="direction"
        type="button"
        role="radio"
        :aria-checked="order === direction"
        class="flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="order === direction ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'"
        @click="selectOrder(direction)"
      >
        {{ direction === 'asc' ? t('monitored.detail.controls.ascending') : t('monitored.detail.controls.descending') }}
      </button>
    </div>
  </div>
</template>
