<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronRight, Search, X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import StoryGuideHereMark from './StoryGuideHereMark.vue'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import { inStoryRows, NOTES_BEFORE_EXPAND, NOTES_PER_EXPAND } from '../lib/in-story-rows'
import type { EntityView, StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ entity: EntityView | undefined; view: StoryGuideView }>()
const emit = defineEmits<{ open: [key: string]; close: [] }>()
const { t } = useI18n()
const details = computed(() => props.entity && props.view.details(props.entity.key))
const newestFirst = ref(false)
const shown = ref(NOTES_BEFORE_EXPAND)
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
    shown: shown.value,
    newestFirst: newestFirst.value,
    chapterTitle: props.view.chapterTitle,
  }),
)
const hereLabel = computed(() => {
  const chapter = props.view.currentChapter?.title
  return chapter ? t('book.detail.storyGuideTab.youAreIn', { chapter }) : t('book.detail.storyGuideTab.youAreHereShort')
})
watch(query, (value) => (shown.value = value.trim() ? NOTES_PER_EXPAND : NOTES_BEFORE_EXPAND))
watch(
  () => props.entity?.key,
  () => {
    newestFirst.value = false
    shown.value = NOTES_BEFORE_EXPAND
    showEarlierDescriptions.value = false
    searching.value = false
    query.value = ''
  },
)

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}

function toggleOrder() {
  newestFirst.value = !newestFirst.value
}

function showMore() {
  shown.value += NOTES_PER_EXPAND
}

function showFewer() {
  shown.value = NOTES_BEFORE_EXPAND
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

        <div :key="entity.key" class="space-y-5 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm">
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
          <section class="rounded-xl border border-border bg-muted/30 p-3.5" data-testid="story-guide-what">
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
          <section v-if="details.notes.length" data-testid="story-guide-in-story">
            <div class="mb-2 flex items-center gap-1">
              <h3 class="me-auto text-sm font-semibold">{{ t('book.detail.storyGuideTab.inTheStory') }}</h3>
              <template v-if="details.notes.length > 1">
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
              </template>
            </div>
            <Input
              v-if="searching"
              ref="searchInput"
              v-model="query"
              type="search"
              class="mb-2 h-8 text-sm"
              :placeholder="t('book.detail.storyGuideTab.searchStory')"
              :aria-label="t('book.detail.storyGuideTab.searchStory')"
            />
            <div class="relative grid grid-cols-[minmax(0,1fr)] gap-3 ps-5.5" data-testid="story-guide-in-story-list">
              <span class="absolute inset-y-1.5 start-1.25 w-px bg-border" aria-hidden="true" />
              <template v-for="row in inStory.rows" :key="row.key">
                <StoryGuideHereMark v-if="row.kind === 'here'" :label="hereLabel" data-testid="story-guide-in-story-here" />
                <button
                  v-else-if="row.kind === 'more'"
                  type="button"
                  class="relative justify-self-start text-xs text-muted-foreground hover:text-foreground"
                  data-testid="story-guide-note-more"
                  @click="showMore"
                >
                  <span
                    class="absolute -start-5.25 top-1 size-2.25 rounded-full border border-dashed border-muted-foreground bg-card"
                    aria-hidden="true"
                  />
                  {{ t('book.detail.storyGuideTab.showEarlierNotes', { count: row.count }) }}
                </button>
                <button
                  v-else-if="row.kind === 'fewer'"
                  type="button"
                  class="justify-self-start text-xs text-muted-foreground hover:text-foreground"
                  data-testid="story-guide-note-fewer"
                  @click="showFewer"
                >
                  {{ t('book.detail.storyGuideTab.showFewer') }}
                </button>
                <div v-else class="relative grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 text-[13.5px]/[1.5]">
                  <span
                    v-if="row.chapter"
                    class="absolute -start-5.25 top-1.5 size-2.25 rounded-full border-[1.5px] border-muted-foreground bg-card"
                    aria-hidden="true"
                  />
                  <span class="truncate text-xs font-medium text-muted-foreground" :title="view.chapterTitle(row.note.s)">{{ row.chapter }}</span>
                  <span>{{ row.note.text }}</span>
                </div>
              </template>
              <p v-if="!inStory.matched" class="text-muted-foreground">{{ t('book.detail.storyGuideTab.noNoteMatch') }}</p>
            </div>
            <p class="mt-2.5 text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.onlyChaptersHere') }}</p>
          </section>
          <section v-if="details.groups.length" class="space-y-2">
            <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.ties') }}</h3>
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
          </section>
          <section v-if="details.often.size">
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.often') }}</h3>
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
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
