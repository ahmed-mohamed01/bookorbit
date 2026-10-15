<script setup lang="ts">
import BookSynopsis from '@/features/book/components/detail/details/BookSynopsis.vue'

defineProps<{
  /** Already sanitised HTML, or null when the work has no description. */
  html: string | null
  /** Resets the toggle when the drawer moves to another work. */
  contentId: string
}>()
</script>

<template>
  <section v-if="html" class="rounded-xl border border-border bg-card px-4 py-3.5" data-testid="synopsis-card">
    <BookSynopsis :html="html" :content-id="contentId" />
  </section>
</template>
