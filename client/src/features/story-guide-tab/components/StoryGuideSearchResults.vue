<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { ChapterPage } from '../lib/chapter-page'
import type { StorySearch, StorySearchChapter } from '../lib/story-guide-search'
import type { EntityGroup, StoryGuideView } from '../lib/story-guide-view'
import StoryGuideEntityCard from './StoryGuideEntityCard.vue'
import StoryGuideHighlight from './StoryGuideHighlight.vue'
import StoryGuidePager from './StoryGuidePager.vue'
import StoryGuideTimelineChapters from './StoryGuideTimelineChapters.vue'

/** Names shown above the events; the rest open in Characters, which holds the full ranked list. */
const NAMES_SHOWN = 6
/** A common word can match nearly every chapter, so summaries arrive a page at a time. */
const SUMMARIES_PAGE = 20

const props = defineProps<{
  view: StoryGuideView
  search: StorySearch
  page: ChapterPage & { chapters: readonly StorySearchChapter[] }
  query: string
  kinds: ReadonlySet<EntityGroup>
  percent: string
  charactersLabel: string
  setTop: (element: unknown) => void
}>()
const emit = defineEmits<{ open: [key: string]; previous: []; next: []; allNames: []; clear: [] }>()
const { t } = useI18n()
const names = computed(() => props.search.names.slice(0, NAMES_SHOWN))
const summaryLimit = ref(SUMMARIES_PAGE)
const summaries = computed(() => props.search.summaries.slice(0, summaryLimit.value))
watch(
  () => props.search,
  () => (summaryLimit.value = SUMMARIES_PAGE),
)
const empty = computed(() => !props.search.names.length && !props.search.notes && !props.search.summaries.length)

function open(key: string) {
  emit('open', key)
}

function allNames() {
  emit('allNames')
}

function moreSummaries() {
  summaryLimit.value += SUMMARIES_PAGE
}

function clear() {
  emit('clear')
}

function previous() {
  emit('previous')
}

function next() {
  emit('next')
}
</script>

<template>
  <section class="min-w-0 space-y-3" data-testid="story-guide-search-results">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="min-w-0 text-base font-semibold break-words">{{ t('book.detail.storyGuideTab.results.heading', { query: query.trim() }) }}</h2>
      <span class="text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.results.aside', { percent }) }}</span>
      <button type="button" class="ms-auto rounded-md px-2 py-1 text-xs hover:bg-muted" @click="clear">
        {{ t('book.detail.storyGuideTab.clearSearch') }}
      </button>
    </header>

    <p v-if="empty" class="text-sm text-muted-foreground" role="status">
      {{ t('book.detail.storyGuideTab.results.none', { query: query.trim(), percent }) }}
    </p>

    <div v-if="search.names.length" class="space-y-2" data-testid="story-guide-search-names">
      <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('book.detail.storyGuideTab.results.names', { count: search.names.length }) }}
      </h3>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2.5">
        <StoryGuideEntityCard
          v-for="entity in names"
          :key="entity.key"
          :entity="entity"
          :since="view.chapterTitle(entity.firstSeen)"
          :query="query"
          @open="open"
        />
      </div>
      <button
        v-if="search.names.length > names.length"
        type="button"
        class="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        @click="allNames"
      >
        {{ t('book.detail.storyGuideTab.results.allNames', { count: search.names.length, section: charactersLabel }) }}
        <ChevronRight class="size-3.5" aria-hidden="true" />
      </button>
    </div>

    <div v-if="search.notes" :ref="setTop" class="scroll-mt-4 space-y-2" data-testid="story-guide-search-timeline">
      <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('book.detail.storyGuideTab.results.timeline', { count: search.notes }) }}
      </h3>
      <StoryGuideTimelineChapters :chapters="page.chapters" :kinds="kinds" :query="query" @open="open" />
      <StoryGuidePager :range="page" @previous="previous" @next="next" />
    </div>

    <div v-if="search.summaries.length" class="space-y-2" data-testid="story-guide-search-summaries">
      <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('book.detail.storyGuideTab.results.summaries', { count: search.summaries.length }) }}
      </h3>
      <ol class="divide-y divide-border rounded-xl border border-border bg-card">
        <li
          v-for="chapter in summaries"
          :key="chapter.s"
          class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3.5 py-2.5 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_3.75rem]"
        >
          <span class="min-w-0 break-words">
            <span class="block font-medium">{{ chapter.title }}</span>
            <span v-for="(summary, index) in chapter.summaries" :key="index" class="mt-1 block text-muted-foreground">
              <StoryGuideHighlight :text="summary" :query="query" />
            </span>
          </span>
          <span class="text-xs tabular-nums text-muted-foreground">{{ Math.round(chapter.start) }}%</span>
        </li>
      </ol>
      <button
        v-if="summaries.length < search.summaries.length"
        type="button"
        class="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted"
        @click="moreSummaries"
      >
        {{ t('book.detail.storyGuideTab.showMore') }}
      </button>
    </div>
  </section>
</template>
