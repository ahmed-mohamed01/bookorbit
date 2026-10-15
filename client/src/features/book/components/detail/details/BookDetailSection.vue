<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="rounded-xl border border-border bg-card" :aria-label="title">
    <div class="flex items-baseline gap-2">
      <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ title }}</h3>
      <div v-if="$slots.aside" class="ml-auto flex min-w-0 items-baseline gap-2">
        <slot name="aside" />
      </div>
    </div>
    <slot />
  </section>
</template>
