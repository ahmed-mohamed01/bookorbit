<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatNumber } from '@/i18n/formatters'
import type { WebSerialSourceOption } from '../lib/serialPresentation'

const props = defineProps<{
  options: WebSerialSourceOption[]
  selected: string | null
  total: number
}>()
const emit = defineEmits<{ select: [sourceName: string | null] }>()

const { t } = useI18n()
const buttons = ref<HTMLButtonElement[]>([])

const segments = computed(() => [
  { value: null as string | null, label: t('webSerials.discover.sourceAll'), count: props.total },
  ...props.options.map((option) => ({ value: option.sourceName as string | null, label: option.sourceName, count: option.count })),
])

function handleSelect(value: string | null) {
  emit('select', value)
}

function focusSegment(index: number) {
  const target = buttons.value[index]
  target?.focus()
}

function handleKeydown(event: KeyboardEvent) {
  const last = segments.value.length - 1
  const current = segments.value.findIndex((segment) => segment.value === props.selected)
  let next: number
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current >= last ? 0 : current + 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current <= 0 ? last : current - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  else return
  event.preventDefault()
  emit('select', segments.value[next]?.value ?? null)
  focusSegment(next)
}
</script>

<template>
  <div class="max-w-full overflow-x-auto" data-testid="source-filter">
    <div
      role="radiogroup"
      :aria-label="t('webSerials.discover.sourceFilterLabel')"
      class="inline-flex w-max gap-0.5 rounded-lg border border-border bg-muted p-0.5"
      @keydown="handleKeydown"
    >
      <button
        v-for="segment in segments"
        :key="segment.value ?? '__all'"
        ref="buttons"
        type="button"
        role="radio"
        :aria-checked="selected === segment.value"
        :tabindex="selected === segment.value ? 0 : -1"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        :class="selected === segment.value ? 'bg-primary text-primary-foreground shadow-xs' : 'text-foreground hover:bg-background/60'"
        @click="handleSelect(segment.value)"
      >
        {{ segment.label }}
        <span class="tabular-nums opacity-70">{{ formatNumber(segment.count) }}</span>
      </button>
    </div>
  </div>
</template>
