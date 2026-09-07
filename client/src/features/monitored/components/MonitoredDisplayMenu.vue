<script setup lang="ts">
import { computed } from 'vue'
import { SlidersHorizontal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import MonitoredDisplayOptionsPanel from './MonitoredDisplayOptionsPanel.vue'
import {
  isDefaultDisplay,
  type MonitoredDisplayClassCounts,
  type MonitoredDisplayOptions,
  type MonitoredReviewKindCounts,
} from '../lib/work-visibility'

const props = defineProps<{
  modelValue: MonitoredDisplayOptions
  counts: MonitoredDisplayClassCounts
  reviewKindCounts: MonitoredReviewKindCounts
  canCurate: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: MonitoredDisplayOptions]; reset: [] }>()

const { t } = useI18n()

const isDefault = computed(() => isDefaultDisplay(props.modelValue))

function update(value: MonitoredDisplayOptions) {
  emit('update:modelValue', value)
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
        :aria-label="t('monitored.display.title')"
        :title="t('monitored.display.title')"
      >
        <SlidersHorizontal :size="13" />
        <span class="hidden lg:inline">{{ t('monitored.display.title') }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-64 p-2">
      <MonitoredDisplayOptionsPanel
        :model-value="modelValue"
        :counts="counts"
        :review-kind-counts="reviewKindCounts"
        :can-curate="canCurate"
        @update:model-value="update"
        @reset="reset"
      />
    </PopoverContent>
  </Popover>
</template>
