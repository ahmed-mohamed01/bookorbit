<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { FORMAT_TO_GROUP, type BookCard } from '@bookorbit/types'
import BookCoverPlaceholder from './BookCoverPlaceholder.vue'
import BookCoverSurface from './BookCoverSurface.vue'
import { COVER_ASPECT_RATIO_KEY, DEFAULT_COVER_ASPECT_RATIO } from '../lib/cover-aspect-ratio'
import { useCoverVersions } from '../composables/useCoverVersions'
import { useDisplaySettings } from '@/composables/useDisplaySettings'

const props = defineProps<{
  book: BookCard
}>()

const route = useRoute()
const router = useRouter()
const coverAspectRatio = inject(COVER_ASPECT_RATIO_KEY, ref(DEFAULT_COVER_ASPECT_RATIO))
const { coverUrl } = useCoverVersions()
const { seriesCardCoverMode } = useDisplaySettings()

const collapsed = computed(() => props.book.collapsedSeries!)
const seriesName = computed(() => props.book.seriesName ?? '')
const authorLine = computed(() => props.book.authors.join(', ') || null)
const hoverTitleClampClass = computed(() => (coverAspectRatio.value === '1/1' ? 'line-clamp-1' : 'line-clamp-2'))

const isMosaic = computed(() => seriesCardCoverMode.value === 'mosaic')

const coverIds = computed(() => collapsed.value.coverBookIds.filter((bookId) => bookId > 0).slice(0, 4))
const tileCount = computed(() => Math.max(coverIds.value.length, 1))

const resolvedCoverId = computed<number | null>(() => {
  const c = collapsed.value
  const fallback = coverIds.value[0] ?? null
  switch (seriesCardCoverMode.value) {
    case 'first-volume':
      return c.firstVolumeBookId ?? fallback
    case 'latest-volume':
      return c.latestVolumeBookId ?? fallback
    case 'first-unread':
      return c.firstUnreadBookId ?? c.firstVolumeBookId ?? fallback
    default:
      return null
  }
})

const failedCovers = ref(new Set<number>())
const singleCoverFailed = ref(false)

watch(resolvedCoverId, () => {
  singleCoverFailed.value = false
})
const primaryFile = computed(() => props.book.files.find((file) => file.role === 'primary') ?? props.book.files[0] ?? null)
const isAudiobook = computed(() => primaryFile.value?.format != null && FORMAT_TO_GROUP[primaryFile.value.format] === 'audio')

function handleCoverError(bookId: number) {
  failedCovers.value = new Set([...failedCovers.value, bookId])
}

function handleSingleCoverError() {
  singleCoverFailed.value = true
}

function handleClick() {
  router.push({ name: 'series-detail', params: { seriesName: seriesName.value }, query: { from: route.fullPath } })
}

function tileClass(index: number): string {
  if (tileCount.value <= 1) return 'col-span-2 row-span-2'
  if (tileCount.value === 2) return 'row-span-2'
  if (tileCount.value === 3 && index === 0) return 'row-span-2'
  return ''
}
</script>

<template>
  <div class="group flex flex-col @container cursor-pointer" @click="handleClick">
    <!-- Cover -->
    <BookCoverSurface
      class="relative w-full rounded-sm overflow-hidden transition-[box-shadow,transform] duration-150 will-change-transform group-hover:scale-[1.02]"
      interactive
      :disable-spine="isAudiobook"
      :style="{ aspectRatio: coverAspectRatio }"
    >
      <!-- Single cover mode -->
      <div v-if="!isMosaic && resolvedCoverId != null" class="absolute inset-0" data-testid="series-single-cover">
        <img
          v-if="!singleCoverFailed"
          :src="coverUrl(resolvedCoverId)"
          class="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          alt=""
          @error="handleSingleCoverError"
        />
        <BookCoverPlaceholder v-else title="" author-line="" :is-audio="false" :seed="`series-${resolvedCoverId}`" />
      </div>

      <!-- Adaptive cover mosaic (default mode) -->
      <div v-else class="absolute inset-0 grid grid-cols-2 grid-rows-2">
        <template v-for="(bookId, i) in coverIds" :key="bookId">
          <div class="relative overflow-hidden" :class="tileClass(i)" data-testid="series-cover-tile">
            <img
              v-if="!failedCovers.has(bookId)"
              :src="coverUrl(bookId)"
              class="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
              alt=""
              @error="() => handleCoverError(bookId)"
            />
            <BookCoverPlaceholder v-else title="" author-line="" :is-audio="false" :seed="`series-${bookId}`" />
          </div>
        </template>
        <div v-if="coverIds.length === 0" class="relative overflow-hidden" :class="tileClass(0)" data-testid="series-cover-fallback">
          <BookCoverPlaceholder title="" author-line="" :is-audio="false" seed="series-empty" />
        </div>
      </div>

      <!-- Count badge -->
      <div
        class="absolute right-1.5 top-1.5 z-10 rounded-sm bg-black/70 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white group-hover:opacity-0 transition-opacity duration-150"
        data-testid="series-count-badge"
      >
        {{ collapsed.bookCount }}
      </div>

      <!-- Hover overlay -->
      <div
        class="absolute inset-0 flex flex-col p-2 bg-black/70 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity duration-150"
      >
        <div class="flex-1" />
        <div class="shrink-0 flex flex-col">
          <p class="text-xs font-semibold text-white leading-tight" :class="hoverTitleClampClass">
            {{ seriesName }}
          </p>
          <p v-if="authorLine" class="text-[10px] text-white/70 truncate mt-0.5">
            {{ authorLine }}
          </p>
        </div>
      </div>
    </BookCoverSurface>
  </div>
</template>
