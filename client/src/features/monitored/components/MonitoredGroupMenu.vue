<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'
import { Layers } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import MonitoredGroupOptions from './MonitoredGroupOptions.vue'

interface GroupOption {
  value: T
  label: string
}

const props = defineProps<{
  options: readonly GroupOption[]
  modelValue: T
  defaultValue?: T
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const { t } = useI18n()

const selectedLabel = computed(() => props.options.find((option) => option.value === props.modelValue)?.label ?? '')
const isDefault = computed(() => props.defaultValue === undefined || props.modelValue === props.defaultValue)

function selectGroup(value: T) {
  if (value !== props.modelValue) emit('update:modelValue', value)
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
        :aria-label="t('monitored.detail.controls.group')"
        :title="selectedLabel"
      >
        <Layers :size="13" />
        <span class="hidden lg:inline">{{ selectedLabel }}</span>
        <span class="lg:hidden">{{ t('monitored.detail.controls.group') }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-56 p-2">
      <MonitoredGroupOptions :options="options" :model-value="modelValue" @update:model-value="selectGroup" />
    </PopoverContent>
  </Popover>
</template>
