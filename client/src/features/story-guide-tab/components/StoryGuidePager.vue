<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { ChapterPage } from '../lib/chapter-page'

defineProps<{ range: ChapterPage }>()
const emit = defineEmits<{ previous: []; next: [] }>()
const { t } = useI18n()

function handlePrevious() {
  emit('previous')
}

function handleNext() {
  emit('next')
}
</script>

<template>
  <nav
    v-if="range.pages > 1"
    class="flex items-center justify-between gap-3 text-xs text-muted-foreground"
    :aria-label="t('book.detail.storyGuideTab.chapterPages')"
    data-testid="story-guide-pager"
  >
    <Button variant="outline" size="sm" :disabled="range.page === 1" @click="handlePrevious">
      <ChevronLeft aria-hidden="true" />{{ t('book.detail.storyGuideTab.previousPage') }}
    </Button>
    <span class="min-w-0 text-center">
      <span class="block truncate">{{ t('book.detail.storyGuideTab.chapterRange', { first: range.first, last: range.last }) }}</span>
      <span class="block tabular-nums">{{ t('book.detail.storyGuideTab.pageOf', { page: range.page, pages: range.pages }) }}</span>
    </span>
    <Button variant="outline" size="sm" :disabled="range.page === range.pages" @click="handleNext">
      {{ t('book.detail.storyGuideTab.nextPage') }}<ChevronRight aria-hidden="true" />
    </Button>
  </nav>
</template>
