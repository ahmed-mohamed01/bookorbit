<script setup lang="ts">
import { Play } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { NARRATION_ABOVE_FOOTER_CLASS } from '../composables/useNarrationDockPosition'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ start: [] }>()

const { t } = useI18n()

function handleStart() {
  emit('start')
}
</script>

<template>
  <Transition name="start-pill">
    <button
      v-if="visible"
      type="button"
      class="fixed z-50 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      :class="NARRATION_ABOVE_FOOTER_CLASS"
      @click="handleStart"
    >
      <Play class="h-3.5 w-3.5" />
      {{ t('reader.header.listenWithNarration') }}
    </button>
  </Transition>
</template>

<style scoped>
.start-pill-enter-active,
.start-pill-leave-active {
  transition:
    opacity 0.3s ease,
    translate 0.3s ease;
}
.start-pill-enter-from,
.start-pill-leave-to {
  opacity: 0;
  translate: -50% 1rem;
}
</style>
