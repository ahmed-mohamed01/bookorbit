<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Select } from '@/components/ui/select'
import { ALL_CHAPTERS, CHAPTER_PAGE_SIZES, isChapterOrder, isChapterPageSize, type ChapterOrder, type ChapterPageSize } from '../lib/chapter-page'

defineProps<{ order: ChapterOrder; size: ChapterPageSize; total: number }>()
const emit = defineEmits<{ 'update:order': [order: ChapterOrder]; 'update:size': [size: ChapterPageSize] }>()
const { t } = useI18n()

function changeOrder(order: string | number) {
  if (isChapterOrder(order)) emit('update:order', order)
}

function changeSize(size: string | number) {
  const value = Number(size)
  if (isChapterPageSize(value)) emit('update:size', value)
}
</script>

<template>
  <span v-if="total > 1" class="flex items-center gap-2">
    <Select
      :model-value="order"
      class="h-8 w-auto text-xs md:text-xs"
      :aria-label="t('book.detail.storyGuideTab.chapterOrder.label')"
      data-testid="story-guide-page-order"
      @update:model-value="changeOrder"
    >
      <option value="newest">{{ t('book.detail.storyGuideTab.chapterOrder.newest') }}</option>
      <option value="oldest">{{ t('book.detail.storyGuideTab.chapterOrder.oldest') }}</option>
    </Select>
    <Select
      v-if="total > CHAPTER_PAGE_SIZES[0]"
      :model-value="size"
      class="h-8 w-auto text-xs md:text-xs"
      :aria-label="t('book.detail.storyGuideTab.chapterPageSize.label')"
      data-testid="story-guide-page-size"
      @update:model-value="changeSize"
    >
      <option v-for="option in CHAPTER_PAGE_SIZES" :key="option" :value="option">
        {{
          option === ALL_CHAPTERS
            ? t('book.detail.storyGuideTab.chapterPageSize.all')
            : t('book.detail.storyGuideTab.chapterPageSize.option', { count: option })
        }}
      </option>
    </Select>
  </span>
</template>
