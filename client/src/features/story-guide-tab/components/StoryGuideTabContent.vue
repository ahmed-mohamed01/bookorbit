<script setup lang="ts">
import { computed, ref } from 'vue'
import { refDebounced } from '@vueuse/core'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Galaxy,
  List,
  Loader2,
  Lock,
  Orbit,
  RefreshCw,
  ScrollText,
  Sparkles,
  Users,
} from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { BookDetail } from '@bookorbit/types'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import StoryGuideConfirmDialog from '@/features/story-guide/components/StoryGuideConfirmDialog.vue'
import {
  storyGuideConfirmation,
  type StoryGuideConfirmation,
  type StoryGuideConfirmationChoice,
} from '@/features/story-guide/lib/story-guide-confirmation'
import { storyGuideBuiltText } from '@/features/story-guide/lib/story-guide-copy'
import type { StoryGuideAction } from '@/features/story-guide/lib/story-guide-presentation'
import { formatPercent } from '@/i18n/formatters'
import { useStoryGuideTab, type GuideSection } from '../composables/useStoryGuideTab'
import { useStoryGuideTabStatus } from '../composables/useStoryGuideTabStatus'
import { storyGuideMenuActions } from '../lib/story-guide-tab-state'
import { ENTITY_GROUPS, matchesName, MIN_STORY_SEARCH, searchStory } from '../lib/story-guide-search'
import { previouslyByChapter, type EntityGroup } from '../lib/story-guide-view'
import { useChapterPages } from '../composables/useChapterPages'
import StoryGuideChapters from './StoryGuideChapters.vue'
import StoryGuideCharacters from './StoryGuideCharacters.vue'
import StoryGuideConstellation from './StoryGuideConstellation.vue'
import StoryGuideEntitySheet from './StoryGuideEntitySheet.vue'
import StoryGuidePager from './StoryGuidePager.vue'
import StoryGuideSearchResults from './StoryGuideSearchResults.vue'
import StoryGuideTabState from './StoryGuideTabState.vue'
import StoryGuideTimelineChapters from './StoryGuideTimelineChapters.vue'
import StoryGuideToolbar from './StoryGuideToolbar.vue'

const props = defineProps<{ book: BookDetail }>()
const { t } = useI18n()
const { coverUrl } = useCoverVersions()
const { status, presentation, pending, perform, mayBuild, readerLoading, readerError, retryReaderStatus } = useStoryGuideTabStatus(
  () => props.book.id,
)
const { section, recap, stopAt, view, error, loadingCut, refreshing, refreshRecap, reload } = useStoryGuideTab(
  () => props.book.id,
  () => status.value,
)
const cover = computed(() => (props.book.coverSource ? coverUrl(props.book.id, 'thumbnail', props.book.coverVersion) : null))

const sections = [
  { id: 'recap', icon: FileText },
  { id: 'timeline', icon: ScrollText },
  { id: 'chapters', icon: List },
  { id: 'characters', icon: Users },
  { id: 'constellation', icon: Orbit },
] as const
const opening = ref<string | null>(null)
const entity = computed(() => (opening.value === null ? undefined : view.value?.byKey.get(opening.value)))
const position = computed(() => recap.value?.position)
const current = computed(() => view.value?.currentChapter)
const placed = computed(() => !!recap.value?.cut)
const percentage = computed(() => position.value?.percentage ?? 0)
const percent = computed(() => formatPercent(percentage.value / 100))
const openingTitle = computed(() => t('book.detail.storyGuideTab.opening'))
const chapterLabel = computed(() => current.value?.title ?? position.value?.chapterTitle ?? openingTitle.value)
const positionLabel = computed(() =>
  placed.value
    ? t('book.detail.storyGuideTab.cut', { percent: percent.value, chapter: chapterLabel.value })
    : t('book.detail.storyGuideTab.noSavedPosition'),
)
const laterChapters = computed(() => view.value?.chapters.filter(({ locked }) => locked).length ?? 0)
const query = ref('')
const searchQuery = refDebounced(query, 150)
const kinds = ref<ReadonlySet<EntityGroup>>(new Set(ENTITY_GROUPS))
const characterGroup = ref<EntityGroup>('people')
const onCharacters = computed(() => section.value === 'characters')
/** Matched from the debounced text only, so typing never rescans the guide; a box emptied below two letters hides them at once. */
const searched = computed(() => (view.value && !onCharacters.value ? searchStory(view.value, searchQuery.value, kinds.value) : null))
const found = computed(() => (query.value.trim().length >= MIN_STORY_SEARCH ? searched.value : null))
const settled = computed(() => query.value.trim() === searchQuery.value.trim())
const counts = computed(() => ({
  recap: null,
  timeline: found.value ? found.value.notes : view.value?.timeline.length,
  chapters: found.value
    ? found.value.summaries.length
    : view.value
      ? `${view.value.chapters.length - laterChapters.value} / ${view.value.chapters.length}`
      : null,
  characters: found.value ? found.value.names.length : view.value?.entities.length,
  constellation: null,
}))
const pressedKinds = computed<ReadonlySet<EntityGroup>>(() => (onCharacters.value ? new Set([characterGroup.value]) : kinds.value))
const kindCounts = computed(() => {
  const groups = view.value?.groups
  if (found.value) return found.value.namesByGroup
  const count = (group: EntityGroup) =>
    onCharacters.value ? (groups?.[group].filter((entity) => matchesName(entity, query.value)).length ?? 0) : (groups?.[group].length ?? 0)
  return { people: count('people'), places: count('places'), terms: count('terms') }
})
const searchPlaceholder = computed(() => t(onCharacters.value ? 'book.detail.storyGuideTab.search' : 'book.detail.storyGuideTab.searchBar'))
const notesByChapter = computed(() => view.value?.chapters.filter(({ notes }) => notes.length) ?? [])
const hereLabel = computed(() => t('book.detail.storyGuideTab.youAreHere', { percent: percent.value }))
const timeline = useChapterPages(
  () => notesByChapter.value,
  () => props.book.id,
)
const previously = useChapterPages(
  () => (view.value ? previouslyByChapter(recap.value?.previously ?? [], view.value, openingTitle.value) : []),
  () => props.book.id,
)
const results = useChapterPages(
  () => found.value?.timeline ?? [],
  () => [props.book.id, searchQuery.value, kinds.value],
)
/** Every pager shares one stored order and size, so the bar binds to the Timeline's and reads the total from the list on screen. */
const pager = computed(() => {
  if (found.value) return results
  if (section.value === 'recap') return previously
  if (section.value === 'timeline') return timeline
  return null
})
const expandedPrevious = ref(new Set<number>())
const stopLabel = computed(() => stopAt.value?.chapterTitle ?? chapterLabel.value)
const stopPercent = computed(() => (stopAt.value ? formatPercent(stopAt.value.percentage / 100) : percent.value))
const stopBehind = computed(() => !!stopAt.value && stopAt.value.percentage !== position.value?.percentage)
const lastTwo = computed(() => recap.value?.previously.slice(-2) ?? [])
const stop = computed(() => recap.value?.stop)
const stopMessage = computed(() => {
  if (!placed.value) return t('book.detail.storyGuideTab.noPosition')
  if (refreshing.value && stop.value?.state === 'skipped') return t('book.detail.storyGuideTab.loadingRecap')
  if (stop.value?.state === 'ok') return ''
  return t(`book.detail.storyGuideTab.stopState.${stop.value?.state ?? 'skipped'}`)
})

const outdated = computed(() => !!(status.value?.guide?.outdated || status.value?.guide?.modelsChanged))
const canUpdate = computed(() => presentation.value.menu.includes('update'))
const menu = computed(() => storyGuideMenuActions(presentation.value))
const actions = computed(() => (mayBuild.value ? menu.value : []))
const timelineHere = computed(() => {
  if (!timeline.page.holdsReader) return null
  return timeline.order === 'newest' ? 'first' : 'last'
})
const noGuide = computed(() => !!status.value && !status.value.guide)
const built = computed(() => (presentation.value.builtNote ? storyGuideBuiltText(presentation.value.builtNote) : null))
const confirmation = ref<StoryGuideConfirmation | null>(null)
const busyChoice = ref<string | null>(null)

function sectionLabel(id: GuideSection) {
  return t(`book.detail.storyGuideTab.sections.${id === 'characters' && view.value?.nonfiction ? 'concepts' : id}`)
}

function changeSection(id: GuideSection) {
  section.value = id
  closeEntity()
}

function openEntity(key: string) {
  opening.value = key
}

function toggleKind(kind: EntityGroup) {
  if (onCharacters.value) {
    characterGroup.value = kind
    return
  }
  const next = new Set(kinds.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  kinds.value = next
}

function clearSearch() {
  query.value = ''
}

function showAllNames() {
  const first = settled.value ? ENTITY_GROUPS.find((group) => kinds.value.has(group) && found.value?.namesByGroup[group]) : undefined
  if (first) characterGroup.value = first
  changeSection('characters')
}

function closeEntity() {
  opening.value = null
}

function showAllChapters() {
  changeSection('chapters')
}

function togglePrevious(s: number) {
  if (expandedPrevious.value.has(s)) expandedPrevious.value.delete(s)
  else expandedPrevious.value.add(s)
}

function requestAction(action: StoryGuideAction) {
  confirmation.value = storyGuideConfirmation(action, status.value)
  if (!confirmation.value) void perform(action)
}

function handleReload() {
  if (readerError.value) retryReaderStatus()
  else reload()
}

function handleUpdate() {
  requestAction('update')
}

function closeConfirmation() {
  confirmation.value = null
}

async function chooseAction(choice: StoryGuideConfirmationChoice) {
  if (!choice.action) return
  busyChoice.value = choice.id
  try {
    await perform(choice.action, choice.fixes)
  } finally {
    busyChoice.value = null
    closeConfirmation()
  }
}
</script>

<template>
  <div class="space-y-3.5">
    <StoryGuideTabState
      v-if="mayBuild && status?.guide && status.job"
      :presentation="presentation"
      :pending="pending"
      :may-build="mayBuild"
      has-guide
      @request="requestAction"
    />

    <div
      v-if="error || readerError"
      class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3.5 text-sm"
      role="status"
    >
      {{ t('book.detail.storyGuideTab.unavailable') }}
      <button type="button" class="rounded-md border border-input bg-background px-2.5 py-1 hover:bg-muted" @click="handleReload">
        {{ t('book.detail.storyGuideTab.refresh') }}
      </button>
    </div>
    <div
      v-else-if="loadingCut || readerLoading"
      class="flex items-center gap-2 rounded-xl border border-border bg-card p-3.5 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {{ t('book.detail.storyGuideTab.loading') }}
    </div>
    <StoryGuideTabState
      v-else-if="noGuide"
      :presentation="presentation"
      :pending="pending"
      :may-build="mayBuild"
      :has-guide="false"
      @request="requestAction"
    />

    <template v-else-if="view && recap">
      <div
        v-if="mayBuild && outdated && !status?.job"
        class="flex flex-wrap items-center gap-2 rounded-xl border border-warning/35 bg-warning/10 px-3.5 py-2.5 text-sm"
        role="status"
      >
        <AlertTriangle class="size-4 shrink-0 text-warning" aria-hidden="true" />
        <p class="min-w-36 flex-1">
          <strong>{{ t('book.detail.storyGuideTab.updateAvailable') }}</strong>
          <span class="text-muted-foreground">{{ t('book.detail.storyGuideTab.updateExplanation') }}</span>
        </p>
        <button
          v-if="mayBuild && canUpdate"
          type="button"
          :disabled="!!pending"
          class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-muted"
          @click="handleUpdate"
        >
          <RefreshCw class="size-3.5" aria-hidden="true" />{{ t('book.detail.storyGuide.update') }}
        </button>
      </div>

      <section
        class="flex items-center gap-3.5 rounded-xl border border-border bg-card px-3.5 py-3"
        :aria-label="t('book.detail.storyGuideTab.cutLabel')"
      >
        <img v-if="cover" :src="cover" alt="" class="h-[4.125rem] w-11 shrink-0 rounded object-cover shadow-sm" />
        <span v-else class="hidden h-[4.125rem] w-11 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground sm:flex"
          ><Galaxy class="size-5" aria-hidden="true"
        /></span>
        <div class="min-w-0 grow">
          <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <strong class="text-[15px] font-semibold tabular-nums">{{ positionLabel }}</strong>
            <span class="text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.follows') }}</span>
          </div>
          <div class="relative mt-2 h-1.5 rounded-full bg-muted" aria-hidden="true">
            <span class="absolute inset-y-0 start-0 rounded-full bg-info" :style="{ width: `${percentage}%` }" />
            <span
              v-for="chapter in view.chapters"
              :key="chapter.s"
              class="absolute top-0 h-full w-px bg-foreground/25"
              :style="{ insetInlineStart: `${chapter.start}%` }"
            />
            <span
              v-if="placed"
              class="absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full border border-background bg-info"
              :style="{ insetInlineStart: `clamp(0px, calc(${percentage}% - 5px), calc(100% - 10px))` }"
            />
          </div>
        </div>
      </section>

      <StoryGuideToolbar
        v-model:query="query"
        v-model:order="timeline.order"
        v-model:size="timeline.size"
        :placeholder="searchPlaceholder"
        :kinds="pressedKinds"
        :counts="kindCounts"
        :paged-total="pager ? pager.page.total : null"
        :actions="actions"
        :pending="!!pending"
        @toggle-kind="toggleKind"
        @request="requestAction"
      />

      <div class="grid gap-3 @[47.5rem]/book-detail:grid-cols-[11.5rem_minmax(0,1fr)] @[47.5rem]/book-detail:gap-5">
        <nav
          :aria-label="t('book.detail.storyGuideTab.sectionNav')"
          class="sticky -top-4 z-10 -mx-4 flex self-start items-center gap-1 overflow-x-auto border-b border-border bg-background px-4 py-2 scrollbar-none sm:-mx-6 sm:px-6 @[47.5rem]/book-detail:top-0 @[47.5rem]/book-detail:mx-0 @[47.5rem]/book-detail:block @[47.5rem]/book-detail:border-0 @[47.5rem]/book-detail:bg-transparent @[47.5rem]/book-detail:p-0"
        >
          <button
            v-for="item in sections"
            :key="item.id"
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap disabled:opacity-40 @[47.5rem]/book-detail:w-full @[47.5rem]/book-detail:gap-2 @[47.5rem]/book-detail:rounded-md @[47.5rem]/book-detail:border-0 @[47.5rem]/book-detail:text-sm"
            :class="
              section === item.id
                ? 'border-primary bg-primary text-primary-foreground @[47.5rem]/book-detail:bg-muted @[47.5rem]/book-detail:text-foreground'
                : 'text-muted-foreground enabled:hover:bg-muted'
            "
            :aria-pressed="section === item.id"
            :disabled="!placed && item.id !== 'recap' && item.id !== 'chapters'"
            @click="changeSection(item.id)"
          >
            <component :is="item.icon" class="hidden size-4 shrink-0 @[47.5rem]/book-detail:block" aria-hidden="true" />
            {{ sectionLabel(item.id) }}
            <span
              v-if="counts[item.id] != null"
              class="ms-auto hidden text-[10px] tabular-nums text-muted-foreground @[47.5rem]/book-detail:inline"
              >{{ counts[item.id] }}</span
            >
          </button>
          <p class="mt-3 hidden border-t border-border px-2 pt-3 text-xs leading-relaxed text-muted-foreground @[47.5rem]/book-detail:block">
            <template v-if="built">{{ built }}<br /></template>{{ t('book.detail.storyGuideTab.aiNote') }}
          </p>
        </nav>

        <StoryGuideSearchResults
          v-if="found"
          :view="view"
          :search="found"
          :page="results.page"
          :query="searchQuery"
          :kinds="kinds"
          :percent="percent"
          :characters-label="sectionLabel('characters')"
          :set-top="results.setTop"
          @open="openEntity"
          @previous="results.previous"
          @next="results.next"
          @all-names="showAllNames"
          @clear="clearSearch"
        />
        <section v-else-if="section === 'recap'" class="min-w-0 space-y-3">
          <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 class="text-base font-semibold">{{ t('book.detail.storyGuideTab.sections.recap') }}</h2>
            <span v-if="placed" class="text-xs text-muted-foreground">{{
              t('book.detail.storyGuideTab.recapAside', { percent: stop?.state === 'ok' ? stopPercent : percent })
            }}</span>
            <button
              v-if="placed"
              type="button"
              class="ms-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              :disabled="refreshing"
              @click="refreshRecap"
            >
              <RefreshCw class="size-3.5" :class="{ 'animate-spin motion-reduce:animate-none': refreshing }" aria-hidden="true" />{{
                t('book.detail.storyGuideTab.refresh')
              }}
            </button>
          </header>
          <div v-if="placed && stop?.state === 'ok'" class="rounded-xl border border-border bg-card p-4">
            <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('book.detail.storyGuideTab.whereStopped', { chapter: stopLabel }) }}
            </h3>
            <p class="mt-1.5 text-sm/relaxed whitespace-pre-line">{{ stop.text }}</p>
            <p v-if="stopBehind" class="mt-2 text-xs text-muted-foreground" data-testid="story-guide-stop-behind">
              {{ t('book.detail.storyGuideTab.stopBehind', { percent: stopPercent }) }}
            </p>
            <p class="mt-3 flex items-start gap-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
              <Sparkles class="size-3.5 shrink-0" aria-hidden="true" />{{ t('book.detail.storyGuideTab.provenance') }}
            </p>
          </div>
          <p v-else-if="stopMessage" class="text-sm text-muted-foreground" role="status">{{ stopMessage }}</p>
          <div v-if="previously.page.total" class="space-y-2">
            <div :ref="previously.setTop" class="mt-4 flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-2">
              <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {{ t('book.detail.storyGuideTab.previously') }}
              </h3>
              <button type="button" class="text-xs text-muted-foreground underline-offset-2 hover:underline" @click="showAllChapters">
                {{ t('book.detail.storyGuideTab.allChapters') }}
              </button>
            </div>
            <ol class="divide-y divide-border rounded-xl border border-border bg-card" data-testid="story-guide-previously">
              <li v-for="chapter in previously.page.chapters" :key="chapter.s">
                <button
                  type="button"
                  class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 px-3.5 py-2.5 text-start text-sm hover:bg-muted/60 focus-visible:outline-ring"
                  :aria-expanded="expandedPrevious.has(chapter.s)"
                  @click="togglePrevious(chapter.s)"
                >
                  <span class="min-w-0 break-words">
                    <span class="block font-medium">{{ chapter.title }}</span>
                    <span class="mt-1 text-muted-foreground" :class="expandedPrevious.has(chapter.s) ? 'block space-y-2' : 'line-clamp-2'">
                      <span v-for="(summary, index) in chapter.summaries" :key="index" :class="expandedPrevious.has(chapter.s) ? 'block' : ''"
                        >{{ summary }}{{ ' ' }}</span
                      >
                    </span>
                  </span>
                  <span class="flex items-start gap-1.5 text-xs tabular-nums text-muted-foreground">
                    <template v-if="chapter.start != null">{{ Math.round(chapter.start) }}%</template>
                    <ChevronDown v-if="expandedPrevious.has(chapter.s)" class="size-3.5" aria-hidden="true" />
                    <ChevronRight v-else class="size-3.5" aria-hidden="true" />
                  </span>
                </button>
              </li>
            </ol>
            <StoryGuidePager :range="previously.page" @previous="previously.previous" @next="previously.next" />
          </div>
        </section>

        <section v-else-if="section === 'timeline'" class="min-w-0 space-y-3">
          <header :ref="timeline.setTop" class="flex scroll-mt-4 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="text-base font-semibold">{{ t('book.detail.storyGuideTab.sections.timeline') }}</h2>
            <span class="text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.timelineAside', { percent }) }}</span>
          </header>
          <div v-if="lastTwo.length" class="space-y-1.5 rounded-xl border border-border bg-card p-3.5 text-sm">
            <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('book.detail.storyGuideTab.whereLeft', { chapter: chapterLabel }) }}
            </h3>
            <p v-for="(item, index) in lastTwo" :key="index">{{ item.text }}</p>
          </div>
          <StoryGuideTimelineChapters
            :chapters="timeline.page.chapters"
            :kinds="kinds"
            :here="timelineHere"
            :here-label="hereLabel"
            @open="openEntity"
          />
          <StoryGuidePager :range="timeline.page" @previous="timeline.previous" @next="timeline.next" />
          <p
            v-if="laterChapters || current"
            class="mt-4 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground"
            data-testid="story-guide-ahead"
          >
            <Lock class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ t('book.detail.storyGuideTab.timelineAhead', { chapter: chapterLabel, count: laterChapters }) }}</span>
          </p>
        </section>

        <StoryGuideChapters v-else-if="section === 'chapters'" :chapters="view.chapters" />
        <StoryGuideCharacters
          v-else-if="section === 'characters'"
          :view="view"
          :percent="percent"
          :group="characterGroup"
          :query="query"
          @open="openEntity"
        />
        <StoryGuideConstellation v-else :view="view" :percent="percent" @open="openEntity" />
        <StoryGuideEntitySheet :entity="entity" :view="view" @open="openEntity" @close="closeEntity" />
      </div>
    </template>
    <StoryGuideConfirmDialog :confirmation="confirmation" :busy-choice="busyChoice" @choose="chooseAction" @close="closeConfirmation" />
  </div>
</template>
