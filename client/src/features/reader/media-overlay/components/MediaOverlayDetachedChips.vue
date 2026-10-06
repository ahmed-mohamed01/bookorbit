<script setup lang="ts">
import { computed } from 'vue'
import { AudioLines, LocateFixed } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useMediaOverlay } from '../composables/useMediaOverlay'

const props = defineProps<{ side: 'back' | 'from-here' }>()

const { t } = useI18n()
const { isDetached, narrateFromHere, returnToNarration } = useMediaOverlay()

const isBack = computed(() => props.side === 'back')
const label = computed(() => (isBack.value ? t('reader.narration.returnToNarration') : t('reader.narration.narrateFromHere')))
const icon = computed(() => (isBack.value ? LocateFixed : AudioLines))

function handleClick() {
  if (isBack.value) returnToNarration()
  else narrateFromHere()
}
</script>

<template>
  <Transition name="chip">
    <button
      v-if="isDetached"
      type="button"
      class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      :class="isBack ? 'border border-border bg-card text-foreground hover:bg-muted' : 'bg-primary text-primary-foreground hover:bg-primary/90'"
      :aria-label="label"
      @click="handleClick"
    >
      <component :is="icon" class="h-3.5 w-3.5" />
      <span class="max-[419px]:hidden">{{ label }}</span>
    </button>
  </Transition>
</template>

<style scoped>
.chip-enter-active,
.chip-leave-active {
  transition:
    opacity 0.2s ease,
    scale 0.2s ease;
}
.chip-enter-from,
.chip-leave-to {
  opacity: 0;
  scale: 0.9;
}
</style>
