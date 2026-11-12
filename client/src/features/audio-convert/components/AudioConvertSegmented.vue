<script setup lang="ts" generic="T extends string">
// Fork: Convert to M4B. BookOrbit-style segmented control: a rounded rectangle, not pills.
defineProps<{
  modelValue: T
  options: { value: T; label: string; count?: number }[]
  label: string
  disabled?: boolean
  /** Stretch the segments across the available width. */
  block?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

function handleSelect(value: T): void {
  emit('update:modelValue', value)
}
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label"
    class="min-w-0 gap-0.5 rounded-md border border-input bg-muted p-0.5"
    :class="[block ? 'flex' : 'inline-flex', disabled ? 'opacity-50' : '']"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === option.value"
      :disabled="disabled"
      class="inline-flex h-6 min-w-0 items-center justify-center gap-1 rounded-xs px-2 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed"
      :class="[
        block ? 'grow basis-0' : '',
        modelValue === option.value
          ? 'bg-background font-semibold text-foreground shadow-xs'
          : 'font-medium text-muted-foreground hover:text-foreground',
      ]"
      @click="handleSelect(option.value)"
    >
      <span class="truncate">{{ option.label }}</span>
      <span v-if="option.count !== undefined" class="tabular-nums" :class="modelValue === option.value ? 'text-foreground' : 'text-muted-foreground'">
        {{ option.count }}
      </span>
    </button>
  </div>
</template>
