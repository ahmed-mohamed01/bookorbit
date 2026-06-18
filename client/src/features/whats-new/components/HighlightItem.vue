<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ReleaseHighlight, ReleaseMedia } from '@bookorbit/types'
import { isAllowedImageHost } from '../lib/whats-new.logic'
import HighlightIcon from './HighlightIcon.vue'
import ImageLightbox from './ImageLightbox.vue'

const props = withDefaults(defineProps<{ highlight: ReleaseHighlight; showMedia?: boolean; compact?: boolean }>(), {
  showMedia: true,
  compact: false,
})

// Local copy so a media item that fails to load can be removed without mutating the prop.
const items = ref<ReleaseMedia[]>([...props.highlight.media])
watch(
  () => props.highlight.media,
  (media) => {
    items.value = [...media]
  },
)

const visibleMedia = computed(() => items.value.filter((m) => isAllowedImageHost(m.url)))
const images = computed(() => visibleMedia.value.filter((m) => m.type === 'image').map((m) => m.url))

// Every image sits in an identical-size frame and is letterboxed inside it (object-contain), so
// highlights with very different screenshot shapes line up uniformly. The frame background fills
// the leftover space; nothing is cropped or distorted.
const mediaFrameClass = computed(() => (props.compact ? 'h-36 w-56' : 'h-48 w-72'))

const lightboxOpen = ref(false)
const lightboxIndex = ref(0)

function openLightbox(item: ReleaseMedia): void {
  const idx = images.value.indexOf(item.url)
  if (idx === -1) return
  lightboxIndex.value = idx
  lightboxOpen.value = true
}

function closeLightbox(): void {
  lightboxOpen.value = false
}

function handleMediaError(item: ReleaseMedia): void {
  items.value = items.value.filter((m) => m !== item)
}
</script>

<template>
  <div class="flex gap-3">
    <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
      <HighlightIcon :name="highlight.icon" :size="16" />
    </span>

    <div class="min-w-0 flex-1">
      <p class="line-clamp-2 text-sm font-semibold text-foreground">{{ highlight.title }}</p>
      <p v-if="highlight.body" class="mt-1 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{{ highlight.body }}</p>

      <div v-if="props.showMedia && visibleMedia.length" class="relative mt-3">
        <span
          v-if="visibleMedia.length > 1"
          class="pointer-events-none absolute right-1 top-1 z-10 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {{ visibleMedia.length }}
        </span>
        <div class="flex gap-2 overflow-x-auto pb-1 snap-x">
          <template v-for="m in visibleMedia" :key="m.url">
            <button
              v-if="m.type === 'image'"
              type="button"
              class="block shrink-0 snap-start overflow-hidden rounded-lg border border-border bg-muted/40 transition-opacity hover:opacity-90"
              :class="mediaFrameClass"
              @click="openLightbox(m)"
            >
              <img :src="m.url" :alt="highlight.title" loading="lazy" class="h-full w-full object-contain" @error="handleMediaError(m)" />
            </button>
            <video
              v-else
              :src="m.url"
              controls
              preload="metadata"
              class="block shrink-0 snap-start rounded-lg border border-border bg-black object-contain"
              :class="mediaFrameClass"
              @error="handleMediaError(m)"
            />
          </template>
        </div>
      </div>
    </div>

    <ImageLightbox v-if="lightboxOpen && images.length" :images="images" :start-index="lightboxIndex" :alt="highlight.title" @close="closeLightbox" />
  </div>
</template>
