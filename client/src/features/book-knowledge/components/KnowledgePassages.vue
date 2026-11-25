<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { BookKnowledgePassage } from '@bookorbit/types'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
defineProps<{ passages: BookKnowledgePassage[]; chapters?: TocItem[]; navigationLocked?: boolean }>()
const emit = defineEmits<{ jump: [passage: BookKnowledgePassage] }>()
const { t } = useI18n()
function chapterLabel(passage: BookKnowledgePassage, chapters: TocItem[] = []): string {
  for (const chapter of chapters) {
    if (chapter.href.split('#')[0] === passage.href.split('#')[0]) return chapter.label
    const nested = chapterLabel(passage, chapter.subitems)
    if (nested) return nested
  }
  return ''
}
function jump(passage: BookKnowledgePassage) {
  emit('jump', passage)
}
</script>
<template>
  <ol class="space-y-3">
    <li v-for="passage in passages" :key="passage.number" class="rounded-md border border-border p-3">
      <p class="text-xs text-muted-foreground">{{ t('bookKnowledge.passage', { number: passage.number }) }} {{ chapterLabel(passage, chapters) }}</p>
      <p class="my-2 text-sm">{{ passage.text }}</p>
      <button class="text-sm text-primary disabled:opacity-50" :disabled="navigationLocked" @click="jump(passage)">
        {{ t('bookKnowledge.jump') }}
      </button>
    </li>
  </ol>
</template>
