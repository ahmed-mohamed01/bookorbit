<script setup lang="ts">
import { computed } from 'vue'

type ToggleSwitchTone = 'success' | 'info' | 'warning'

const props = defineProps<{ modelValue: boolean; disabled?: boolean; tone?: ToggleSwitchTone }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

// Without a tone the switch keeps the app's primary colour, so the many settings switches stay as they were.
const CHECKED_CLASS: Record<ToggleSwitchTone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
}

const trackClass = computed(() => {
  if (!props.modelValue) return 'bg-muted'
  return props.tone ? CHECKED_CLASS[props.tone] : 'bg-primary'
})

function handleToggle() {
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer overflow-hidden rounded-full border-2 border-transparent p-0 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    :class="trackClass"
    :disabled="disabled"
    @click="handleToggle"
  >
    <span
      class="pointer-events-none absolute top-0 inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-[inset-inline-start]"
      :class="modelValue ? 'start-4' : 'start-0'"
      style="transition-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1)"
    />
  </button>
</template>
