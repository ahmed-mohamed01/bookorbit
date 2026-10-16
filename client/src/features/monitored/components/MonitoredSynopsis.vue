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
  <!-- Two lines are enough in the panel; the shared clamp grows with the window, which pushes the editions off screen. -->
  <section
    v-if="html"
    class="rounded-xl border border-border bg-card px-3.5 py-2.5 [&_.synopsis-copy--clamped]:[-webkit-line-clamp:2]! [&_[data-test=synopsis-copy]]:text-[13px]"
    data-testid="synopsis-card"
  >
    <BookSynopsis :html="html" :content-id="contentId" />
  </section>
</template>
