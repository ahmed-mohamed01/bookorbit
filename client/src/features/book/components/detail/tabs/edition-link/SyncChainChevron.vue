<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'

defineProps<{ expanded: boolean; controls: string; label: string }>()
const emit = defineEmits<{ toggle: [] }>()

function handleClick() {
  emit('toggle')
}
</script>

<template>
  <button
    type="button"
    class="-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    :aria-expanded="expanded"
    :aria-controls="expanded ? controls : undefined"
    :aria-label="label"
    data-testid="sync-chain-explain-toggle"
    @click="handleClick"
  >
    <ChevronDown class="size-3.5 transition-transform motion-reduce:transition-none" :class="expanded ? 'rotate-180' : ''" aria-hidden="true" />
  </button>
</template>
