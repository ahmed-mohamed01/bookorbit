<script setup lang="ts">
import BookCoverArtwork from '@/features/book/components/BookCoverArtwork.vue'

defineProps<{
  src: string | null
  title: string | null
  seed: string
  authors?: readonly string[] | null
  seriesName?: string | null
  seriesIndex?: string | number | null
  dashed?: boolean
}>()
</script>

<template>
  <span
    class="relative h-12 w-8 shrink-0 overflow-hidden rounded-[2px] bg-muted"
    :class="dashed && !src ? 'border border-dashed border-border' : ''"
    aria-hidden="true"
  >
    <BookCoverArtwork
      :src="src"
      :has-cover="src !== null"
      :title="title"
      :authors="authors ?? null"
      :series-name="seriesName ?? null"
      :series-index="seriesIndex ?? null"
      :seed="seed"
      alt=""
      mode="fill-crop"
      loading="lazy"
      decoding="async"
    />
  </span>
</template>
