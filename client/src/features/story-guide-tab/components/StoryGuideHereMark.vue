<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <p class="relative flex items-center gap-2 text-xs font-medium text-info">
    <span class="absolute -start-5.5 size-2.75 rounded-full border-2 border-info bg-card" aria-hidden="true" />
    {{ label }}<span class="grow border-t border-dashed border-info/50" aria-hidden="true" />
  </p>
</template>
