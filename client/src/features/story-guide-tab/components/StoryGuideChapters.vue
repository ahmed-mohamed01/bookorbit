<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, Lock, MapPin } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ chapters: StoryGuideView['chapters'] }>()
const openCount = computed(() => props.chapters.filter((chapter) => !chapter.locked).length)
const { t } = useI18n()
const expanded = ref(new Set<number>())

function toggle(spine: number) {
  if (expanded.value.has(spine)) expanded.value.delete(spine)
  else expanded.value.add(spine)
}
</script>

<template>
  <div class="space-y-3">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-base font-semibold">{{ t('book.detail.storyGuideTab.sections.chapters') }}</h2>
      <span class="text-xs text-muted-foreground">{{
        t('book.detail.storyGuideTab.chaptersOpen', { open: openCount, total: chapters.length })
      }}</span>
    </header>
    <ol class="divide-y divide-border rounded-xl border border-border bg-card">
      <li v-for="chapter in chapters" :key="chapter.s" class="[content-visibility:auto] [contain-intrinsic-size:auto_3.75rem]">
        <div v-if="chapter.locked" class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3.5 py-2.5 text-sm text-muted-foreground">
          <div>
            <div class="font-medium break-words">{{ chapter.title }}</div>
            <div class="mt-2 space-y-1.5" role="img" :aria-label="t('book.detail.storyGuideTab.hidden')">
              <div class="h-1.5 w-4/5 rounded-full bg-border/60" />
              <div class="h-1.5 w-1/2 rounded-full bg-border/60" />
            </div>
          </div>
          <span class="flex items-start gap-1.5 text-xs tabular-nums">
            <Lock class="size-3.5" aria-hidden="true" />{{ Math.round(chapter.start) }}%
          </span>
        </div>
        <button
          v-else
          type="button"
          class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 px-3.5 py-2.5 text-start text-sm hover:bg-muted/60 focus-visible:outline-ring"
          :aria-expanded="expanded.has(chapter.s)"
          @click="toggle(chapter.s)"
        >
          <span class="min-w-0 break-words">
            <span class="block font-medium">{{ chapter.title }}</span>
            <span class="mt-1 text-muted-foreground" :class="expanded.has(chapter.s) ? 'block space-y-2' : 'line-clamp-2'">
              <span v-for="(summary, index) in chapter.summaries" :key="index" :class="expanded.has(chapter.s) ? 'block' : ''"
                >{{ summary }}{{ ' ' }}</span
              >
            </span>
            <span v-if="chapter.current && chapter.hidden" class="mt-2 flex items-start gap-1.5 text-xs text-info">
              <MapPin class="size-3.5 shrink-0" aria-hidden="true" />
              {{ t('book.detail.storyGuideTab.partial', { count: chapter.hidden }) }}
            </span>
          </span>
          <span class="flex flex-wrap items-start justify-end gap-1.5 text-xs tabular-nums text-muted-foreground">
            <span v-if="chapter.current" class="rounded-full bg-info/10 px-1.5 text-info max-sm:hidden">{{
              t('book.detail.storyGuideTab.reading')
            }}</span>
            {{ Math.round(chapter.start) }}%
            <ChevronDown v-if="expanded.has(chapter.s)" class="size-3.5" aria-hidden="true" />
            <ChevronRight v-else class="size-3.5" aria-hidden="true" />
          </span>
        </button>
      </li>
    </ol>
  </div>
</template>
