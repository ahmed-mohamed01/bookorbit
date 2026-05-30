<script setup lang="ts">
import { computed } from 'vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'

const props = withDefaults(
  defineProps<{
    size?: 'default' | 'mini'
    interactive?: boolean
    tag?: string
    disableSpine?: boolean
  }>(),
  {
    size: 'default',
    interactive: false,
    tag: 'div',
    disableSpine: false,
  },
)

const { bookSpineOverlay, bookShadowStrength } = useDisplaySettings()

const spineOverlayMode = computed(() => {
  if (props.disableSpine) return 'off'
  return bookSpineOverlay?.value ?? 'off'
})

const shadowStrengthMode = computed(() => bookShadowStrength?.value ?? 'default')

const classes = computed(() => [
  'book-cover-surface',
  props.size === 'mini' ? 'book-cover-surface--mini' : '',
  props.interactive ? 'book-cover-surface--interactive' : '',
])
</script>

<template>
  <component
    :is="tag"
    :class="classes"
    :data-cover-size="size"
    :data-cover-shadow="shadowStrengthMode"
    :data-cover-spine="spineOverlayMode"
    :data-cover-interactive="interactive ? 'true' : 'false'"
  >
    <slot />
  </component>
</template>
