<script setup lang="ts">
import { computed } from 'vue'
import { BookOpen, Link2, Play } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { FORMAT_TO_GROUP } from '@bookorbit/types'

import { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import BookCoverArtwork from '@/features/book/components/BookCoverArtwork.vue'
import BookCoverSurface from '@/features/book/components/BookCoverSurface.vue'
import { useCurrentlyReadingWidget } from '../../composables/useCurrentlyReadingWidget'
import {
  EDITION_STACK_MAX_VISIBLE,
  editionStackBadgeStyle,
  editionStackLayout,
  stackCurrentlyReading,
  type CurrentlyReadingStack,
} from '../../lib/currently-reading-stacks'

const { data, loading, error } = useCurrentlyReadingWidget()
const { t } = useI18n()
const router = useRouter()
const { coverUrl } = useCoverVersions()

const stacks = computed(() => stackCurrentlyReading(data.value?.books ?? []))

function stackedEditions(stack: CurrentlyReadingStack) {
  return stack.editions.slice(0, EDITION_STACK_MAX_VISIBLE)
}

function stackedLayout(stack: CurrentlyReadingStack) {
  return editionStackLayout(stack.editions.length)
}

function stackedBadgeStyle(stack: CurrentlyReadingStack) {
  return editionStackBadgeStyle(stack.editions.length)
}

function goToBook(bookId: number) {
  void router.push({ name: 'book-detail', params: { bookId } })
}

function isComic(fileFormat: string | null): boolean {
  return fileFormat != null && FORMAT_TO_GROUP[fileFormat] === 'cbx'
}

function continueReading(bookId: number, fileId: number | null, fileFormat: string | null) {
  if (fileId) {
    void router.push({ name: 'reader', params: { bookId, fileId }, query: { format: fileFormat ?? 'epub' } })
  } else {
    void router.push({ name: 'book-detail', params: { bookId } })
  }
}
</script>

<template>
  <div class="flex h-full flex-col p-3">
    <div class="mb-3 flex items-center gap-2 self-start">
      <BookOpen :size="16" class="text-primary" />
      <span class="text-[15px] font-semibold text-foreground">{{ t('dashboard.widgets.currentlyReading.title') }}</span>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-1 gap-3">
      <div v-for="n in 2" :key="n" class="flex w-full gap-2.5">
        <div class="h-16 w-11 shrink-0 animate-pulse rounded bg-muted" />
        <div class="flex-1 space-y-2">
          <div class="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div class="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
          <div class="mt-1 h-1.5 w-full animate-pulse rounded-full bg-muted" />
        </div>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t('dashboard.common.failedToLoad') }}
    </div>

    <!-- Empty -->
    <div v-else-if="!data || data.books.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <BookOpen :size="16" class="text-muted-foreground" />
      </div>
      <p class="text-center text-xs text-muted-foreground">{{ t('dashboard.widgets.currentlyReading.empty') }}</p>
    </div>

    <!-- Books list -->
    <div v-else class="flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
      <div class="flex flex-col gap-2">
        <div
          v-for="stack in stacks"
          :key="stack.lead.bookId"
          class="group/book relative flex min-w-0 cursor-pointer gap-2.5 rounded-lg bg-muted/20 p-1.5 transition-colors hover:bg-muted/40"
          @click="goToBook(stack.lead.bookId)"
        >
          <div
            v-if="stack.editions.length > 1"
            class="relative isolate h-14 w-9 shrink-0"
            role="img"
            :aria-label="t('dashboard.widgets.currentlyReading.editions', { count: stack.editions.length })"
          >
            <div
              v-for="(edition, i) in stackedEditions(stack)"
              :key="edition.bookId"
              class="absolute overflow-hidden rounded bg-surface-3 ring-1 ring-background"
              :style="stackedLayout(stack)[i]"
            >
              <BookCoverArtwork
                :src="coverUrl(edition.bookId)"
                :has-cover="edition.hasCover"
                :title="edition.title"
                :seed="edition.title ?? String(edition.bookId)"
                alt=""
                mode="fill-crop"
              />
            </div>
            <span
              class="absolute z-10 flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-primary text-primary-foreground shadow ring-1 ring-background"
              :style="stackedBadgeStyle(stack)"
              :title="t('dashboard.widgets.currentlyReading.editions', { count: stack.editions.length })"
              data-testid="edition-link-pill"
            >
              <Link2 :size="9" aria-hidden="true" />
            </span>
          </div>

          <!-- Cover thumbnail -->
          <BookCoverSurface
            v-else
            size="mini"
            class="book-cover-surface--spine-fitted h-14 w-9 shrink-0 overflow-hidden rounded"
            :is-comic="isComic(stack.lead.fileFormat)"
          >
            <BookCoverArtwork
              :src="coverUrl(stack.lead.bookId)"
              :has-cover="stack.lead.hasCover"
              :title="stack.lead.title"
              :author-line="stack.lead.authors.length > 0 ? stack.lead.authors.join(', ') : null"
              :is-audio="false"
              :seed="stack.lead.title ?? String(stack.lead.bookId)"
              :alt="stack.lead.title ?? t('dashboard.common.bookCover')"
              frame-aspect-ratio="9/14"
              :is-comic="isComic(stack.lead.fileFormat)"
            />
          </BookCoverSurface>

          <!-- Info -->
          <div class="flex min-w-0 flex-1 flex-col justify-center">
            <p class="truncate text-xs font-semibold leading-tight">{{ stack.lead.title ?? t('dashboard.common.untitled') }}</p>
            <p v-if="stack.lead.authors.length > 0" class="truncate text-xs text-muted-foreground">
              {{ stack.lead.authors.join(', ') }}
            </p>
            <!-- Progress bar -->
            <div class="mt-1.5 flex items-center gap-1.5">
              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div class="h-full rounded-full bg-primary transition-all duration-300" :style="{ width: `${Math.round(stack.lead.progress)}%` }" />
              </div>
              <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground">{{ Math.round(stack.lead.progress) }}%</span>
            </div>
          </div>

          <!-- Continue button (hover) -->
          <button
            class="absolute right-2 top-1/3 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition-opacity group-hover/book:opacity-100"
            :title="t('dashboard.widgets.currentlyReading.continueReading')"
            @click.stop="continueReading(stack.lead.bookId, stack.lead.fileId, stack.lead.fileFormat)"
          >
            <Play :size="11" class="translate-x-px" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
