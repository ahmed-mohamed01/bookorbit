<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronRight, Search, X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from 'reka-ui'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import StoryGuideHereMark from './StoryGuideHereMark.vue'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import { inStoryRows } from '../lib/in-story-rows'
import type { EntityView, StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ entity: EntityView | undefined; view: StoryGuideView }>()
const emit = defineEmits<{ open: [key: string]; close: [] }>()
const { t } = useI18n()
const details = computed(() => props.entity && props.view.details(props.entity.key))
const newestFirst = ref(false)
const all = ref(false)
const tab = ref<'timeline' | 'ties'>('timeline')
const showEarlierDescriptions = ref(false)
const searching = ref(false)
const query = ref('')
const searchInput = ref<{ $el: HTMLInputElement } | null>(null)
const person = computed(() => props.entity?.kind === 'character' || props.entity?.kind === 'group')
const description = computed(() => props.entity?.profiles[0])
const earlierDescriptions = computed(() => [...(props.entity?.profiles.slice(1) ?? [])].reverse())
const inStory = computed(() =>
  inStoryRows(details.value?.notes ?? [], {
    query: query.value,
    all: all.value,
    newestFirst: newestFirst.value,
    chapterTitle: props.view.chapterTitle,
  }),
)
const hereLabel = computed(() => {
  const chapter = props.view.currentChapter?.title
  return chapter ? t('book.detail.storyGuideTab.youAreIn', { chapter }) : t('book.detail.storyGuideTab.youAreHereShort')
})
const hasTies = computed(() => !!details.value && (details.value.groups.length > 0 || details.value.often.size > 0))
const hasTimeline = computed(() => !!details.value?.notes.length)

const MIN_LIST_HEIGHT = 240
const DISPLAY_ALL_ROOM = 72
/** A list this close to fitting runs on: folding it would hide a line or two behind a button. */
const FIT_SLACK = 96
const scroller = ref<HTMLElement | null>(null)
const card = ref<HTMLElement | null>(null)
const clip = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const listHeight = ref(MIN_LIST_HEIGHT)
const overflowing = ref(false)
const clipped = computed(() => !all.value && (inStory.value.hidden > 0 || overflowing.value))

/** Collapsed, the list runs from where it starts to the bottom of the sheet, leaving room for the Display all node. */
function measure() {
  const box = scroller.value
  const frame = clip.value
  if (!box || !frame) return
  // Layout offsets, not client rects: the sheet slides in with a transform while this first runs.
  const top = frame.offsetTop - box.offsetTop
  listHeight.value = Math.max(MIN_LIST_HEIGHT, Math.floor(box.clientHeight - top - DISPLAY_ALL_ROOM))
  overflowing.value = (list.value?.offsetHeight ?? 0) > listHeight.value + FIT_SLACK
}
useResizeObserver([scroller, card, list], measure)
watch([clip, () => props.entity?.key, query, newestFirst, all, showEarlierDescriptions], measure, { flush: 'post' })
watch(
  () => props.entity?.key,
  () => {
    newestFirst.value = false
    all.value = false
    tab.value = hasTimeline.value ? 'timeline' : 'ties'
    showEarlierDescriptions.value = false
    searching.value = false
    query.value = ''
  },
  { immediate: true },
)

watch([hasTimeline, hasTies], ([timeline, ties]) => {
  if (tab.value === 'ties' && !ties) tab.value = 'timeline'
  else if (tab.value === 'timeline' && !timeline && ties) tab.value = 'ties'
})

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}

function toggleOrder() {
  newestFirst.value = !newestFirst.value
}

function displayAll() {
  all.value = true
}

function handleTabChange(value: string | number) {
  tab.value = value === 'ties' ? 'ties' : 'timeline'
}

function toggleEarlierDescriptions() {
  showEarlierDescriptions.value = !showEarlierDescriptions.value
}

async function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) {
    query.value = ''
    return
  }
  await nextTick()
  searchInput.value?.$el.focus()
}
</script>

<template>
  <DialogRoot :open="!!entity" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim" />
      <DialogContent
        v-if="entity && details"
        :aria-describedby="undefined"
        class="fixed inset-y-0 end-0 z-50 flex w-full flex-col border-border bg-card shadow-2xl sm:max-w-md sm:border-s"
      >
        <header class="flex items-start justify-between gap-3 border-b border-border p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div class="min-w-0">
            <DialogTitle class="text-lg font-semibold break-words">{{ entity.name }}</DialogTitle>
            <p class="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span class="inline-flex items-center gap-1"
                ><component :is="entityKindIcon(entity.kind)" class="size-3 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />{{
                  t(`book.detail.storyGuideTab.kinds.${entity.kind}`, t('book.detail.storyGuideTab.kinds.term'))
                }}</span
              >
              <span>{{ t(`book.detail.storyGuideTab.importance.${entity.importance}`) }}</span>
              <span>{{ t('book.detail.storyGuideTab.since', { chapter: view.chapterTitle(entity.firstSeen) }) }}</span>
            </p>
          </div>
          <DialogClose class="rounded-md p-1.5 hover:bg-muted" :aria-label="t('book.detail.storyGuideTab.close')">
            <X class="size-4" aria-hidden="true" />
          </DialogClose>
        </header>

        <div ref="scroller" :key="entity.key" class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm">
          <section v-if="entity.aliases.length">
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('book.detail.storyGuideTab.alsoKnownAs') }}
            </h3>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="alias in entity.aliases"
                :key="alias.name"
                class="inline-flex flex-wrap items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                <component :is="entityKindIcon(entity.kind)" class="size-3 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />
                {{ alias.name }}
                <span class="text-muted-foreground">{{ view.chapterTitle(alias.s) }}</span>
              </span>
            </div>
          </section>
          <section ref="card" class="rounded-xl border border-border bg-muted/30 p-3.5" data-testid="story-guide-what">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {{ t(person ? 'book.detail.storyGuideTab.who' : 'book.detail.storyGuideTab.whatItIs') }}
              </h3>
              <span v-if="entity.lastSeen" class="text-xs text-muted-foreground">{{
                t('book.detail.storyGuideTab.lastSeen', { chapter: entity.lastSeen })
              }}</span>
              <span v-else-if="description" class="text-xs text-muted-foreground">{{
                t('book.detail.storyGuideTab.asOf', { chapter: view.chapterTitle(description.s) })
              }}</span>
            </div>
            <p class="mt-1.5 text-[14px]/[1.55]" :class="{ 'text-muted-foreground': !description }">
              {{ description?.text ?? t('book.detail.storyGuideTab.noProfile') }}
            </p>
            <template v-if="earlierDescriptions.length">
              <button
                type="button"
                class="mt-2.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                :aria-expanded="showEarlierDescriptions"
                data-testid="story-guide-earlier-descriptions"
                @click="toggleEarlierDescriptions"
              >
                <ChevronDown v-if="showEarlierDescriptions" class="size-3.5" aria-hidden="true" />
                <ChevronRight v-else class="size-3.5" aria-hidden="true" />
                {{ t('book.detail.storyGuideTab.earlierDescriptions', { count: earlierDescriptions.length }) }}
              </button>
              <ul v-if="showEarlierDescriptions" class="mt-1.5 space-y-2.5 border-s border-border ps-3">
                <li v-for="profile in earlierDescriptions" :key="`${profile.s}:${profile.text}`" class="text-muted-foreground">
                  <span class="block text-xs">{{ t('book.detail.storyGuideTab.asOf', { chapter: view.chapterTitle(profile.s) }) }}</span>
                  {{ profile.text }}
                </li>
              </ul>
            </template>
          </section>
          <TabsRoot v-if="hasTimeline || hasTies" :model-value="tab" @update:model-value="handleTabChange">
            <div class="mb-3 flex min-h-9 items-end gap-1 border-b border-border">
              <TabsList class="me-auto flex gap-5" :aria-label="t('book.detail.storyGuideTab.entryTabs')">
                <TabsTrigger
                  v-if="hasTimeline"
                  value="timeline"
                  class="-mb-px border-b-2 border-transparent pb-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  data-testid="story-guide-tab-timeline"
                >
                  {{ t('book.detail.storyGuideTab.sections.timeline') }}
                </TabsTrigger>
                <TabsTrigger
                  v-if="hasTies"
                  value="ties"
                  class="-mb-px border-b-2 border-transparent pb-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  data-testid="story-guide-tab-ties"
                >
                  {{ t('book.detail.storyGuideTab.ties') }}
                </TabsTrigger>
              </TabsList>
              <div v-if="tab === 'timeline' && details.notes.length > 1" class="flex gap-1 pb-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  :class="{ 'bg-accent text-accent-foreground': searching }"
                  :aria-label="t('book.detail.storyGuideTab.searchStory')"
                  :title="t('book.detail.storyGuideTab.searchStory')"
                  :aria-pressed="searching"
                  data-testid="story-guide-note-search"
                  @click="toggleSearch"
                >
                  <Search class="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  :aria-label="t(newestFirst ? 'book.detail.storyGuideTab.showOldestFirst' : 'book.detail.storyGuideTab.showNewestFirst')"
                  :title="t(newestFirst ? 'book.detail.storyGuideTab.showOldestFirst' : 'book.detail.storyGuideTab.showNewestFirst')"
                  data-testid="story-guide-note-order"
                  @click="toggleOrder"
                >
                  <ArrowDownWideNarrow v-if="newestFirst" class="size-3.5" aria-hidden="true" />
                  <ArrowUpNarrowWide v-else class="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <TabsContent v-if="hasTimeline" value="timeline" data-testid="story-guide-in-story">
              <Input
                v-if="searching"
                ref="searchInput"
                v-model="query"
                type="search"
                class="mb-3 h-8 text-sm"
                :placeholder="t('book.detail.storyGuideTab.searchStory')"
                :aria-label="t('book.detail.storyGuideTab.searchStory')"
              />
              <div ref="clip" class="relative overflow-hidden" :style="clipped ? { maxHeight: `${listHeight}px` } : undefined">
                <div ref="list" class="relative grid grid-cols-[minmax(0,1fr)] gap-3 ps-5.5" data-testid="story-guide-in-story-list">
                  <span class="absolute inset-y-1.5 start-1.25 w-px bg-border" aria-hidden="true" />
                  <template v-for="row in inStory.rows" :key="row.key">
                    <StoryGuideHereMark v-if="row.kind === 'here'" :label="hereLabel" data-testid="story-guide-in-story-here" />
                    <div v-else class="relative text-[13.5px]/[1.5]">
                      <span
                        v-if="row.chapter"
                        class="absolute -start-5.25 top-1.5 size-2.25 rounded-full border-[1.5px] border-muted-foreground bg-card"
                        aria-hidden="true"
                      />
                      <span v-if="row.chapter" class="block truncate font-semibold">{{ row.chapter }}</span>
                      <span class="block">{{ row.note.text }}</span>
                    </div>
                  </template>
                  <p v-if="!inStory.matched" class="text-muted-foreground">{{ t('book.detail.storyGuideTab.noNoteMatch') }}</p>
                </div>
                <div v-if="clipped" class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card" aria-hidden="true" />
              </div>
              <button
                v-if="clipped"
                type="button"
                class="relative ms-5.5 mt-2 text-sm font-medium text-primary hover:underline"
                data-testid="story-guide-display-all"
                @click="displayAll"
              >
                <span class="absolute -start-5.25 top-1.25 size-2.25 rounded-full bg-primary" aria-hidden="true" />
                {{ t('book.detail.storyGuideTab.displayAll', { count: inStory.matched }) }}
              </button>
              <p class="mt-2.5 text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.onlyChaptersHere') }}</p>
            </TabsContent>
            <TabsContent v-if="hasTies" value="ties" class="space-y-5" data-testid="story-guide-ties">
              <div v-if="details.groups.length" class="space-y-2">
                <div v-for="group in details.groups" :key="group.group" class="divide-y divide-border rounded-lg border border-border">
                  <h4 class="px-2.5 py-1 text-xs font-medium text-muted-foreground">{{ t(`book.detail.storyGuideTab.tieGroups.${group.group}`) }}</h4>
                  <button
                    v-for="tie in group.ties"
                    :key="tie.key"
                    type="button"
                    class="flex w-full gap-2 px-2.5 py-2 text-start hover:bg-muted"
                    @click="emit('open', tie.a.key === entity.key ? tie.b.key : tie.a.key)"
                  >
                    <span class="min-w-0 flex-1 break-words">
                      <component
                        :is="entityKindIcon(tie.a.kind)"
                        class="me-1 inline size-3 align-[-1px]"
                        :class="entityKindColor(tie.a.kind)"
                        aria-hidden="true"
                      /><strong>{{ tie.a.name }}</strong>
                      {{ tie.label }}
                      <component
                        :is="entityKindIcon(tie.b.kind)"
                        class="me-1 inline size-3 align-[-1px]"
                        :class="entityKindColor(tie.b.kind)"
                        aria-hidden="true"
                      /><strong>{{ tie.b.name }}</strong>
                      <span v-if="tie.note" class="block text-xs text-muted-foreground">{{ tie.note }}</span>
                      <span v-else-if="tie.quotes[0] && 'q' in tie.quotes[0]" class="block text-xs text-muted-foreground">{{ tie.quotes[0].q }}</span>
                    </span>
                    <span class="text-xs tabular-nums text-muted-foreground">{{ tie.quotes.length }}×</span>
                  </button>
                </div>
              </div>
              <section v-if="details.often.size">
                <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {{ t('book.detail.storyGuideTab.often') }}
                </h3>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="other in details.often"
                    :key="other.key"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs hover:bg-accent"
                    @click="emit('open', other.key)"
                  >
                    <component :is="entityKindIcon(other.kind)" class="size-3 shrink-0" :class="entityKindColor(other.kind)" aria-hidden="true" />
                    {{ other.name }}
                  </button>
                </div>
              </section>
            </TabsContent>
          </TabsRoot>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
