<script setup lang="ts">
withDefaults(defineProps<{ reasons: string[]; textSize?: 'xs' | 'sm'; stacked?: boolean }>(), { textSize: 'xs', stacked: false })
</script>

<template>
  <ul v-if="reasons.length" :class="stacked ? 'flex max-w-full flex-col items-start gap-1' : 'flex flex-wrap gap-1'" data-testid="review-reasons">
    <li
      v-for="reason in reasons"
      :key="reason"
      class="rounded-sm bg-muted px-1.5 py-0.5 font-medium leading-none text-muted-foreground"
      :class="[textSize === 'sm' ? 'text-[10px]' : 'text-[9px]', stacked ? 'max-w-full truncate' : '']"
    >
      {{ reason }}
    </li>
  </ul>
</template>
