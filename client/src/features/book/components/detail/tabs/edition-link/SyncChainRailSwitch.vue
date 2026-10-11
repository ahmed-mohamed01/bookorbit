<script setup lang="ts">
import { computed } from 'vue'
import { Link2Off } from '@lucide/vue'
import type { ChainFrame, ChainIcon, ChainTone } from '@/features/book/lib/sync-chain'
import { CHAIN_ICON, CHAIN_ICON_MOTION, CHAIN_SWITCH_TRACK_CLASS, CHAIN_TONE_TEXT_CLASS } from './chain-ui'

const props = withDefaults(
  defineProps<{ modelValue: boolean; tone: ChainTone; icon: ChainIcon; disabled?: boolean; label: string; size?: ChainFrame }>(),
  { size: 'spine' },
)
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const trackClass = computed(() => (props.modelValue ? CHAIN_SWITCH_TRACK_CLASS[props.tone] : 'bg-muted'))
const SIZE_CLASS: Record<ChainFrame, { track: string; thumb: string; on: string; icon: string }> = {
  spine: { track: 'h-5 w-9', thumb: 'size-4', on: 'start-4', icon: 'size-3' },
  group: { track: 'h-4 w-7', thumb: 'size-3', on: 'start-3', icon: 'size-2.5' },
}

const sizeClass = computed(() => SIZE_CLASS[props.size])
const thumbClass = computed(() => [
  sizeClass.value.thumb,
  props.modelValue ? sizeClass.value.on : 'start-0',
  props.modelValue ? CHAIN_TONE_TEXT_CLASS[props.tone] : 'text-muted-foreground',
])
const thumbIcon = computed(() => (props.modelValue ? CHAIN_ICON[props.icon] : Link2Off))
const iconClass = computed(() => (props.modelValue ? CHAIN_ICON_MOTION[props.icon] : ''))

// aria-disabled rather than disabled, so the switch keeps focus while the panel is busy and its reason stays reachable.
function handleToggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    class="relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent p-0 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    :class="[sizeClass.track, trackClass]"
    :aria-disabled="disabled ? 'true' : undefined"
    data-testid="sync-chain-rail-switch"
    @click="handleToggle"
  >
    <span
      class="pointer-events-none absolute top-0 flex items-center justify-center rounded-full bg-background shadow-sm transition-[inset-inline-start] ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none"
      :class="thumbClass"
      data-testid="sync-chain-rail-thumb"
    >
      <component :is="thumbIcon" :class="[sizeClass.icon, iconClass]" aria-hidden="true" />
    </span>
  </button>
</template>
