<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from '@lucide/vue'

const props = defineProps<{
  modelValue: string
  options: string[]
  placeholder: string
  label: string
  testid: string
  disabled?: boolean
  maxlength?: number
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const inputRef = ref<HTMLInputElement | null>(null)
const open = ref(false)
// Opening the list shows every option; filtering starts only once the user actually types, so a
// row already holding a full path still offers the complete pick-list.
const filtering = ref(false)

const filteredOptions = computed(() => {
  if (!filtering.value) return props.options
  const query = props.modelValue.trim().toLowerCase()
  if (!query) return props.options
  return props.options.filter((option) => option.toLowerCase().includes(query))
})

function handleInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  filtering.value = true
  open.value = true
}

function handleFocus(): void {
  if (props.disabled) return
  filtering.value = false
  open.value = true
}

function handleBlur(): void {
  open.value = false
}

// The chevron keeps focus off the input (@mousedown.prevent), so opening from it has to focus the
// input itself: without focus nothing ever blurs and Escape, bound on the input, never reaches the list.
function handleToggle(): void {
  if (props.disabled) return
  filtering.value = false
  if (open.value) {
    open.value = false
    return
  }
  open.value = true
  inputRef.value?.focus()
}

function handleEscape(): void {
  open.value = false
}

function selectOption(option: string): void {
  emit('update:modelValue', option)
  filtering.value = false
  open.value = false
}
</script>

<template>
  <div class="relative min-w-0">
    <input
      ref="inputRef"
      :value="modelValue"
      type="text"
      spellcheck="false"
      :maxlength="maxlength"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-label="label"
      :data-testid="testid"
      aria-haspopup="listbox"
      :aria-expanded="open"
      class="h-9 w-full rounded-md border border-border bg-background pl-3 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
      @input="handleInput"
      @focus="handleFocus"
      @blur="handleBlur"
      @keydown.escape="handleEscape"
    />
    <button
      type="button"
      tabindex="-1"
      :disabled="disabled"
      :aria-label="`Show known folders for ${label}`"
      class="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground disabled:opacity-40"
      @mousedown.prevent
      @click="handleToggle"
    >
      <ChevronDown class="size-3.5 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <div
      v-if="open && filteredOptions.length > 0"
      role="listbox"
      :data-testid="`${testid}-options`"
      class="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card py-1 shadow-[var(--elevation-xs)]"
    >
      <button
        v-for="option in filteredOptions"
        :key="option"
        type="button"
        role="option"
        class="block w-full truncate px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
        @mousedown.prevent
        @click="selectOption(option)"
      >
        {{ option }}
      </button>
    </div>
  </div>
</template>
