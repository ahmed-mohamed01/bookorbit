<script setup lang="ts">
defineProps<{ open: boolean; contentId?: string }>()
</script>

<template>
  <Transition name="section">
    <div v-if="open" :id="contentId">
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.section-enter-active,
.section-leave-active {
  transition:
    opacity 0.2s ease,
    max-height 0.2s ease;
  overflow: hidden;
}
.section-enter-from,
.section-leave-to {
  opacity: 0;
  max-height: 0;
}
.section-enter-to,
.section-leave-from {
  opacity: 1;
  max-height: 60rem;
}

@media (prefers-reduced-motion: reduce) {
  .section-enter-active,
  .section-leave-active {
    transition: none;
  }
}
</style>
