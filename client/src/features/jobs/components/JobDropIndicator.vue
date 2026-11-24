<script setup lang="ts">
defineProps<{ line: { top: number; left: number; width: number } | null }>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="line"
      class="pointer-events-none fixed z-50 h-[2px] -translate-y-1/2 bg-primary"
      :style="{ top: `${line.top}px`, left: `${line.left}px`, width: `${line.width}px` }"
      aria-hidden="true"
    />
  </Teleport>
</template>
