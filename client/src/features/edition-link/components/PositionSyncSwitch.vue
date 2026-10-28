<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkPositionSync } from '@bookorbit/types'
import { nextRovingIndex } from '@/lib/roving-index'

const props = defineProps<{ modelValue: WorkPositionSync; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: WorkPositionSync] }>()

const { t } = useI18n()

const OPTIONS: WorkPositionSync[] = ['off', 'precise', 'rough']
const group = ref<HTMLElement | null>(null)

function select(value: WorkPositionSync) {
  if (!props.disabled) emit('update:modelValue', value)
}

function handleOptionClick(event: MouseEvent) {
  const value = (event.currentTarget as HTMLElement).dataset.value as WorkPositionSync
  select(value)
}

function handleKeydown(event: KeyboardEvent) {
  const next = nextRovingIndex(event.key, OPTIONS.indexOf(props.modelValue), OPTIONS.length)
  if (next === null) return
  event.preventDefault()
  const value = OPTIONS[next]!
  select(value)
  void nextTick(() => group.value?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.focus())
}
</script>

<template>
  <div
    ref="group"
    role="radiogroup"
    :aria-label="t('settings.integrations.editionLinks.sharing.positionSync.label')"
    class="inline-flex shrink-0 gap-0.5 rounded-md border border-border bg-muted p-0.5"
    :class="disabled ? 'opacity-50' : ''"
    @keydown="handleKeydown"
  >
    <button
      v-for="option in OPTIONS"
      :key="option"
      :data-value="option"
      type="button"
      role="radio"
      :disabled="disabled"
      :aria-checked="modelValue === option"
      :tabindex="modelValue === option ? 0 : -1"
      class="inline-flex h-7 items-center rounded-xs px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      :class="
        modelValue === option ? 'bg-background font-semibold text-foreground shadow-xs' : 'font-medium text-muted-foreground hover:text-foreground'
      "
      @click="handleOptionClick"
    >
      {{ t(`settings.integrations.editionLinks.sharing.positionSync.${option}`) }}
    </button>
  </div>
</template>
