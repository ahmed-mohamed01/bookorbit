<script setup lang="ts" generic="T extends string">
import { useI18n } from 'vue-i18n'

interface GroupOption {
  value: T
  label: string
}

const props = defineProps<{
  options: readonly GroupOption[]
  modelValue: T
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const { t } = useI18n()

function selectGroup(value: T) {
  if (value !== props.modelValue) emit('update:modelValue', value)
}
</script>

<template>
  <div>
    <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">{{ t('monitored.detail.controls.group') }}</div>
    <div class="flex flex-col gap-0.5" role="radiogroup" :aria-label="t('monitored.detail.controls.group')">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="option.value === modelValue"
        class="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="option.value === modelValue ? 'font-medium text-foreground' : 'text-muted-foreground'"
        @click="selectGroup(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>
