<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { I18nT, useI18n } from 'vue-i18n'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Search, UserPlus, X } from '@lucide/vue'
import type { MonitoredAuthorSearchResult, WebSerialCatalogEntry } from '@bookorbit/types'
import AppIcon from '@/components/AppIcon.vue'
import AuthorPortrait from '@/features/author/components/AuthorPortrait.vue'
import BookFormatChip from '@/features/book/components/BookFormatChip.vue'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import { bookFormatEntries } from '@/features/book/lib/book-formats'
import BookUploadModal from '@/features/library/components/BookUploadModal.vue'
import { formatNumber, formatPercent } from '@/i18n/formatters'
import MonitorAuthorModal from '@/features/monitored/components/MonitorAuthorModal.vue'
import MonitoredFormatStatusChip from '@/features/monitored/components/MonitoredFormatStatusChip.vue'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { providerChipStyle } from '@/lib/provider-colors'
import { useCommandPalette } from '../composables/useCommandPalette'
import { useCommandPaletteResults, type PaletteItem, type PaletteTab } from '../composables/useCommandPaletteResults'
import { highlightSegments } from '../lib/highlight'
import { usePaletteRowActions } from '../composables/usePaletteRowActions'
import PaletteCover from './PaletteCover.vue'

const { t } = useI18n()
const router = useRouter()
const { coverUrl } = useCoverVersions()
const { isOpen, closePalette } = useCommandPalette()

const monitorResult = ref<MonitoredAuthorSearchResult | null>(null)
const { watchedFormats, requestFormat, requestWork, requestBusy, followAuthor, isFollowed, isFollowing } = usePaletteRowActions()
function closeMonitor() {
  monitorResult.value = null
}

const query = ref('')
const tab = ref<PaletteTab>('all')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const uploadOpen = ref(false)

function navigate(to: RouteLocationRaw) {
  closePalette()
  void router.push(to)
}

function openUpload() {
  closePalette()
  uploadOpen.value = true
}

const { activate, sections, tabs, isSearching, loading, settled, hasMoreBooks, loadingMoreBooks, loadMoreBooks, clear } = useCommandPaletteResults(
  query,
  tab,
  isOpen,
  { openUpload, navigate },
)

const flatItems = computed(() => sections.value.flatMap((section) => section.items.filter(isSelectable)))
const resultCount = computed(() => flatItems.value.filter((item) => !['more', 'externalSearch', 'seriesMore', 'skeleton'].includes(item.kind)).length)
const showEmpty = computed(() => isSearching.value && settled.value && resultCount.value === 0)
const activeOptionId = computed(() => (flatItems.value.length ? optionId(activeIndex.value) : undefined))

/** Each row's position in the flat list, so arrow keys can walk across section boundaries. */
const indexByKey = computed(() => new Map(flatItems.value.map((item, index) => [item.key, index])))

function optionId(index: number) {
  return `command-palette-option-${index}`
}

function indexOf(item: PaletteItem) {
  return indexByKey.value.get(item.key) ?? -1
}

watch(flatItems, (items, previous) => {
  // Only a row the user moved to is followed across updates; the top row stays the top result.
  const key = activeIndex.value > 0 ? previous?.[activeIndex.value]?.key : undefined
  const index = items.findIndex((item) => item.key === key)
  activeIndex.value = index >= 0 ? index : 0
})

watch(query, () => {
  tab.value = 'all'
})

watch(isOpen, (open) => {
  if (open) return
  query.value = ''
  tab.value = 'all'
  clear()
})

watch(activeIndex, (index) => {
  void nextTick(() => document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' }))
})

function handleOpenChange(open: boolean) {
  if (!open) closePalette()
}

function handleOpenAutoFocus(event: Event) {
  event.preventDefault()
  inputRef.value?.focus()
}

function isSelectable(item: PaletteItem) {
  return item.kind !== 'skeleton'
}

function select(item: PaletteItem) {
  if (!isSelectable(item)) return
  const author = activate(item)
  if (author) {
    closePalette()
    monitorResult.value = author
  }
  if (item.kind === 'action') closePalette()
  if (item.kind === 'more') {
    listRef.value?.scrollTo({ top: 0 })
    inputRef.value?.focus()
  }
}

function selectTab(next: PaletteTab) {
  tab.value = next
  inputRef.value?.focus()
}

function cycleTab(step: number) {
  const ids = tabs.value.map((option) => option.id)
  if (ids.length < 2) return
  const current = Math.max(0, ids.indexOf(tab.value))
  tab.value = ids[(current + step + ids.length) % ids.length] ?? 'all'
}

function handleKeydown(event: KeyboardEvent) {
  const count = flatItems.value.length
  if (event.key === 'ArrowDown' && count) {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % count
  } else if (event.key === 'ArrowUp' && count) {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + count) % count
  } else if (event.key === 'Enter') {
    const item = flatItems.value[activeIndex.value]
    if (!item) return
    event.preventDefault()
    select(item)
  } else if (event.key === 'Tab' && tabs.value.length > 1) {
    event.preventDefault()
    cycleTab(event.shiftKey ? -1 : 1)
  }
}

function hover(item: PaletteItem) {
  if (isSelectable(item)) activeIndex.value = indexOf(item)
}

function clearQuery() {
  query.value = ''
  inputRef.value?.focus()
}

function handleListScroll(event: Event) {
  if (tab.value !== 'books' || !hasMoreBooks.value || loadingMoreBooks.value) return
  const el = event.currentTarget as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) void loadMoreBooks()
}

function closeUpload() {
  uploadOpen.value = false
}

function mangaSubtitle(entry: WebSerialCatalogEntry) {
  return [entry.authors.join(', '), entry.year].filter(Boolean).join(' · ')
}

function bookSubtitle(item: PaletteItem) {
  if (item.kind !== 'book' && item.kind !== 'reading') return ''
  return item.book.authors.join(', ')
}

function seriesLabel(item: PaletteItem) {
  if (item.kind !== 'book' || !item.book.seriesName) return ''
  return item.book.seriesIndex ? `${item.book.seriesName} #${item.book.seriesIndex}` : item.book.seriesName
}

function progressOf(item: PaletteItem) {
  return item.kind === 'reading' ? Math.round(item.book.readingProgress ?? 0) : 0
}

/** Cover rows need their height; icon-only rows (places, actions) sit tighter so lists scan quickly. */
function rowSizeClass(item: PaletteItem) {
  if (item.kind === 'more') return 'py-1.5'
  if (item.kind === 'place' || item.kind === 'action') return 'min-h-9 py-1'
  return 'min-h-10 py-1.5'
}

function segments(text: string | null | undefined) {
  return highlightSegments(text ?? '', isSearching.value ? query.value : '')
}

const highlightClass = 'rounded-[2px] bg-(--shell-accent-tint) font-semibold text-foreground'
</script>

<template>
  <MonitorAuthorModal
    :open="monitorResult !== null"
    :result="monitorResult"
    :initial-formats="['ebook']"
    @close="closeMonitor"
    @created="closeMonitor"
  />
  <DialogRoot :open="isOpen" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[60] bg-scrim" />
      <DialogContent
        class="fixed top-[12vh] left-1/2 z-[60] flex max-h-[min(76vh,46rem)] w-[min(42.5rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-xl outline-none max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0"
        @open-auto-focus="handleOpenAutoFocus"
      >
        <DialogTitle class="sr-only">{{ t('commandPalette.title') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t('commandPalette.description') }}</DialogDescription>

        <div class="flex h-14 shrink-0 items-center gap-3 border-b border-border ps-4 pe-3 max-sm:ps-1.5 max-sm:gap-1.5">
          <button
            type="button"
            class="grid size-9 shrink-0 place-items-center rounded-md text-foreground hover:bg-(--shell-accent-wash) sm:hidden"
            :aria-label="t('commandPalette.close')"
            @click="closePalette"
          >
            <ArrowLeft :size="18" aria-hidden="true" />
          </button>
          <Search :size="18" class="shrink-0 text-muted-foreground max-sm:hidden" aria-hidden="true" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-list"
            :aria-activedescendant="activeOptionId"
            :aria-label="t('commandPalette.title')"
            :placeholder="t('commandPalette.placeholder')"
            spellcheck="false"
            autocomplete="off"
            class="h-full min-w-0 flex-1 bg-transparent text-base text-foreground caret-primary outline-none placeholder:text-muted-foreground"
            @keydown="handleKeydown"
          />
          <Loader2 v-if="loading" :size="16" class="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
          <button
            v-if="query"
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-(--shell-accent-wash) hover:text-foreground"
            :aria-label="t('commandPalette.clear')"
            @click="clearQuery"
          >
            <X :size="16" aria-hidden="true" />
          </button>
          <kbd
            class="hidden h-5 shrink-0 select-none items-center rounded-xs border border-(--shell-accent-line) px-1.5 font-mono text-[11px] font-semibold text-muted-foreground sm:inline-flex"
            aria-hidden="true"
            >{{ t('commandPalette.keys.escape') }}</kbd
          >
        </div>

        <div v-if="tabs.length" class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2 scrollbar-none">
          <button
            v-for="option in tabs"
            :key="option.id"
            type="button"
            class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors"
            :class="
              tab === option.id
                ? 'border-(--shell-accent-line) bg-(--shell-accent-tint) text-primary'
                : 'border-transparent text-foreground hover:bg-(--shell-accent-wash)'
            "
            :aria-pressed="tab === option.id"
            @click="selectTab(option.id)"
          >
            {{ option.label }}
            <span v-if="option.count != null" class="text-xs tabular-nums" :class="tab === option.id ? 'text-primary' : 'text-muted-foreground'">{{
              formatNumber(option.count)
            }}</span>
          </button>
        </div>

        <div
          id="command-palette-list"
          ref="listRef"
          role="listbox"
          :aria-label="t('commandPalette.title')"
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pt-1 pb-1.5"
          @scroll.passive="handleListScroll"
        >
          <p v-if="isSearching && loading && resultCount === 0" class="px-3 py-8 text-center text-[13px] text-muted-foreground">
            {{ t('components.appHeader.searching') }}
          </p>
          <p v-else-if="showEmpty" class="px-3 py-8 text-center text-[13px] text-muted-foreground">{{ t('components.appHeader.noResults') }}</p>

          <div v-for="section in sections" :key="section.id" role="group" :aria-labelledby="`command-palette-section-${section.id}`">
            <div class="flex items-center justify-between px-2.5 pt-2.5 pb-1.5">
              <span :id="`command-palette-section-${section.id}`" class="sidebar-section-label">{{ section.label }}</span>
              <span v-if="section.count != null" class="text-xs text-muted-foreground tabular-nums">{{ formatNumber(section.count) }}</span>
            </div>

            <div
              v-for="item in section.items"
              :id="isSelectable(item) ? optionId(indexOf(item)) : undefined"
              :key="item.key"
              :role="isSelectable(item) ? 'option' : undefined"
              :aria-selected="isSelectable(item) ? indexOf(item) === activeIndex : undefined"
              class="flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 text-start"
              :class="[indexOf(item) === activeIndex ? 'bg-accent' : '', rowSizeClass(item)]"
              @mousemove="hover(item)"
              @click="select(item)"
            >
              <template v-if="item.kind === 'skeleton'">
                <span class="h-12 w-8 shrink-0 animate-pulse rounded-[2px] bg-muted motion-reduce:animate-none" aria-hidden="true" />
                <span class="min-w-0 flex-1 space-y-1.5" aria-hidden="true">
                  <span class="block h-3.5 w-1/2 animate-pulse rounded-xs bg-muted motion-reduce:animate-none" />
                  <span class="block h-3 w-1/3 animate-pulse rounded-xs bg-muted motion-reduce:animate-none" />
                </span>
              </template>

              <template v-else-if="item.kind === 'lightNovel'">
                <PaletteCover :src="item.suggestion.cover" :title="item.suggestion.title" :seed="item.key" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.suggestion.title)" :key="i"
                      ><span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span
                      ><template v-else>{{ seg.text }}</template></template
                    >
                  </span>
                  <span class="mt-0.5 block text-[13px] text-muted-foreground">{{
                    t('commandPalette.sitesCount', { count: item.suggestion.sourcesCount })
                  }}</span>
                </span>
                <span
                  v-if="item.suggestion.inLibrary"
                  class="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-1.5 text-[10px] font-medium text-success"
                  :aria-label="t('webSerials.discover.series.inLibraryLabel')"
                  ><Check :size="10" :stroke-width="2.5" aria-hidden="true" />{{ t('webSerials.discover.series.inLibrary') }}</span
                >
                <span v-if="item.suggestion.mtlOnly" class="rounded-xs bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{{
                  t('commandPalette.mtl')
                }}</span>
              </template>
              <template v-else-if="item.kind === 'manga' || item.kind === 'lightNovelEntry'">
                <PaletteCover :src="item.entry.coverUrl" :title="item.entry.title" :authors="item.entry.authors" :seed="item.key" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.entry.title)" :key="i"
                      ><span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span
                      ><template v-else>{{ seg.text }}</template></template
                    >
                  </span>
                  <I18nT v-if="item.aka" keypath="commandPalette.alsoKnownAs" tag="span" class="mt-0.5 block truncate text-xs text-muted-foreground">
                    <template #title
                      ><template v-for="(seg, i) in segments(item.aka)" :key="i"
                        ><span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span
                        ><template v-else>{{ seg.text }}</template></template
                      ></template
                    >
                  </I18nT>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">{{ mangaSubtitle(item.entry) }}</span>
                </span>
                <span
                  v-if="item.entry.inLibrary"
                  class="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-1.5 text-[10px] font-medium text-success"
                  :aria-label="t('webSerials.discover.series.inLibraryLabel')"
                  ><Check :size="10" :stroke-width="2.5" aria-hidden="true" />{{ t('webSerials.discover.series.inLibrary') }}</span
                >
              </template>
              <template v-else-if="item.kind === 'seriesMore'">
                <span class="w-8 shrink-0" aria-hidden="true" />
                <span class="text-[13px] font-medium text-primary">{{ t('commandPalette.moreWebSerials') }}</span>
              </template>

              <template v-else-if="item.kind === 'watchlist'">
                <PaletteCover
                  :src="toMonitoredCoverUrl(item.hit.work.coverUrl) || null"
                  :title="item.hit.work.title"
                  :authors="[item.hit.authorName]"
                  :series-name="item.hit.work.seriesName"
                  :series-index="item.hit.work.seriesIndex"
                  :seed="item.key"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.hit.work.title)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    {{ item.hit.authorName }}
                    <template v-if="item.hit.work.seriesName">
                      ·
                      <i>{{ item.hit.work.seriesName }}</i>
                    </template>
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-1">
                  <MonitoredFormatStatusChip
                    v-for="format in watchedFormats(item.hit)"
                    :key="format.format"
                    :work="item.hit.work"
                    :format="format.format"
                    :status="format.status"
                  />
                </span>
                <button
                  v-if="requestFormat(item.hit)"
                  type="button"
                  class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--shell-accent-line) bg-(--shell-accent-wash) px-2.5 text-xs font-medium text-primary hover:bg-(--shell-accent-tint) disabled:opacity-60"
                  :disabled="requestBusy.has(item.hit.work.id)"
                  @mousedown.prevent
                  @click.stop="requestWork(item.hit)"
                >
                  <Plus :size="13" aria-hidden="true" />
                  {{ t('commandPalette.actions.requestFormat', { format: t(`monitored.formats.${requestFormat(item.hit)}`) }) }}
                </button>
              </template>

              <template v-else-if="item.kind === 'hardcoverBook'">
                <PaletteCover
                  :src="toMonitoredCoverUrl(item.book.coverUrl) || null"
                  :title="item.book.title"
                  :authors="item.book.authorNames"
                  :series-name="item.book.seriesName"
                  :seed="item.key"
                  dashed
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.book.title)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    {{ item.book.authorNames.join(', ') }}
                    <template v-if="item.book.seriesName">
                      ·
                      <i>{{ item.book.seriesName }}</i>
                    </template>
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-0.5">
                  <button
                    v-if="item.book.authorNames.length"
                    type="button"
                    class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-(--shell-accent-wash) hover:text-foreground disabled:hover:bg-transparent"
                    :class="isFollowed(item.book) ? 'text-primary' : ''"
                    :title="t('commandPalette.actions.followAuthor', { name: item.book.authorNames[0] })"
                    :aria-label="t('commandPalette.actions.followAuthor', { name: item.book.authorNames[0] })"
                    :disabled="isFollowed(item.book) || isFollowing(item.book)"
                    @mousedown.prevent
                    @click.stop="followAuthor(item.book)"
                  >
                    <Check v-if="isFollowed(item.book)" :size="15" aria-hidden="true" />
                    <Loader2 v-else-if="isFollowing(item.book)" :size="15" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    <UserPlus v-else :size="15" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="ms-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-(--shell-accent-line) bg-(--shell-accent-wash) px-2.5 text-xs font-medium text-primary hover:bg-(--shell-accent-tint)"
                    @mousedown.prevent
                    @click.stop="select(item)"
                  >
                    <Plus :size="13" aria-hidden="true" />
                    {{ t('commandPalette.actions.request') }}
                  </button>
                </span>
              </template>

              <template v-else-if="item.kind === 'hardcoverAuthor'">
                <span class="size-8 shrink-0 overflow-hidden rounded-full bg-muted">
                  <img
                    v-if="toMonitoredCoverUrl(item.author.imageUrl)"
                    :src="toMonitoredCoverUrl(item.author.imageUrl)"
                    alt=""
                    class="size-full object-cover"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.author.name)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span v-if="item.author.bookCount != null" class="mt-0.5 block truncate text-[13px] text-muted-foreground">{{
                    t('components.appHeader.bookCount', { count: item.author.bookCount })
                  }}</span>
                </span>
                <span class="provider-chip shrink-0 rounded-xs px-1.5 py-0.5 text-[11px] font-semibold" :style="providerChipStyle('hardcover')">{{
                  t('commandPalette.kinds.hardcover')
                }}</span>
              </template>

              <template v-else-if="item.kind === 'externalSearch'">
                <span class="grid size-8 shrink-0 place-items-center rounded-(--shell-radius) bg-muted text-muted-foreground">
                  <Search :size="16" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">{{ item.label }}</span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">{{ item.description }}</span>
                </span>
                <span
                  v-if="item.providers.includes('hardcover')"
                  class="provider-chip shrink-0 rounded-xs px-1.5 py-0.5 text-[11px] font-semibold"
                  :style="providerChipStyle('hardcover')"
                  >{{ t('commandPalette.kinds.hardcover') }}</span
                >
              </template>

              <template v-else-if="item.kind === 'book' || item.kind === 'reading'">
                <PaletteCover
                  :src="item.book.hasCover ? coverUrl(item.book.id, 'thumbnail', item.book.coverVersion) : null"
                  :title="item.book.title"
                  :authors="item.book.authors"
                  :series-name="item.book.seriesName"
                  :series-index="item.book.seriesIndex"
                  :seed="String(item.book.id)"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.book.title)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    <template v-for="(seg, i) in segments(bookSubtitle(item))" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                    <template v-if="seriesLabel(item)">
                      ·
                      <i>{{ seriesLabel(item) }}</i>
                    </template>
                  </span>
                </span>
                <span v-if="item.kind === 'reading'" class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                  <span class="h-1 w-14 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span class="block h-full rounded-full bg-primary" :style="{ width: `${progressOf(item)}%` }" />
                  </span>
                  {{ formatPercent(progressOf(item) / 100) }}
                </span>
                <span v-else class="flex shrink-0 gap-1">
                  <BookFormatChip
                    v-for="entry in bookFormatEntries(item.book.files)"
                    :key="entry.key"
                    :format-key="entry.key"
                    class="gap-0.5 rounded-xs px-1 py-0.5 text-[11px]"
                  />
                </span>
              </template>

              <template v-else-if="item.kind === 'author'">
                <span class="size-8 shrink-0 overflow-hidden rounded-full bg-muted">
                  <AuthorPortrait :author="item.author" shape="circle" :show-source-badge="false" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.author.name)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">{{
                    t('components.appHeader.bookCount', { count: item.author.bookCount })
                  }}</span>
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ t('commandPalette.kinds.author') }}</span>
              </template>

              <template v-else-if="item.kind === 'series'">
                <span class="relative h-12 w-8 shrink-0">
                  <span class="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-[2px] border border-border bg-muted" aria-hidden="true" />
                  <PaletteCover
                    class="relative"
                    :src="item.series.coverBookIds[0] ? coverUrl(item.series.coverBookIds[0]) : null"
                    :title="item.series.name"
                    :authors="item.series.authors"
                    :seed="item.key"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    <template v-for="(seg, i) in segments(item.series.name)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    <template v-if="item.series.authors.length">{{ item.series.authors.join(', ') }} · </template>
                    {{ t('components.appHeader.bookCount', { count: item.series.bookCount }) }}
                  </span>
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ t('commandPalette.kinds.series') }}</span>
              </template>

              <template v-else-if="item.kind === 'place'">
                <span class="grid h-7 w-8 shrink-0 place-items-center text-sidebar-foreground">
                  <component :is="item.icon" v-if="typeof item.icon !== 'string'" :size="17" aria-hidden="true" />
                  <AppIcon v-else :icon="item.icon" :fallback="item.fallbackIcon" :size="17" />
                </span>
                <span class="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
                  <template v-for="(seg, i) in segments(item.label)" :key="i">
                    <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ item.meta }}</span>
              </template>

              <template v-else-if="item.kind === 'setting'">
                <span
                  class="grid size-8 shrink-0 place-items-center rounded-(--shell-radius) border border-(--shell-accent-line) bg-(--shell-accent-wash) text-sidebar-foreground"
                >
                  <component :is="item.icon" :size="16" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">
                    {{ item.label }}
                    <span class="font-normal text-muted-foreground">· {{ item.groupLabel }}</span>
                  </span>
                  <span v-if="item.description" class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    <template v-for="(seg, i) in segments(item.description)" :key="i">
                      <span v-if="seg.match" :class="highlightClass">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ t('commandPalette.kinds.setting') }}</span>
              </template>

              <template v-else-if="item.kind === 'action'">
                <span class="grid h-7 w-8 shrink-0 place-items-center text-sidebar-foreground">
                  <component :is="item.icon" :size="17" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">{{ item.label }}</span>
              </template>

              <template v-else-if="item.kind === 'more'">
                <span class="w-8 shrink-0" aria-hidden="true" />
                <span class="inline-flex items-center gap-2 text-[13px] font-medium text-primary">
                  {{ item.label }}
                  <ArrowRight :size="14" class="rtl:rotate-180" aria-hidden="true" />
                </span>
              </template>
            </div>
          </div>

          <p v-if="tab === 'books' && loadingMoreBooks" class="px-3 py-3 text-center text-[13px] text-muted-foreground">
            {{ t('components.appHeader.loadingMore') }}
          </p>
        </div>

        <div
          class="flex h-10 shrink-0 items-center gap-4 border-t border-border px-3.5 text-xs text-muted-foreground max-sm:hidden"
          aria-hidden="true"
        >
          <span class="inline-flex items-center gap-1.5">
            <kbd class="cp-kbd">↑</kbd><kbd class="cp-kbd">↓</kbd>{{ t('commandPalette.hints.navigate') }}
          </span>
          <span class="inline-flex items-center gap-1.5"><kbd class="cp-kbd">↵</kbd>{{ t('commandPalette.hints.open') }}</span>
          <span v-if="tabs.length > 1" class="inline-flex items-center gap-1.5"
            ><kbd class="cp-kbd">{{ t('commandPalette.keys.tab') }}</kbd
            >{{ t('commandPalette.hints.filter') }}</span
          >
          <span class="flex-1" />
          <span class="inline-flex items-center gap-1.5"
            ><kbd class="cp-kbd">{{ t('commandPalette.keys.escape') }}</kbd
            >{{ t('commandPalette.hints.close') }}</span
          >
        </div>

        <p class="sr-only" aria-live="polite">{{ isSearching && settled ? t('commandPalette.resultCount', { count: resultCount }) : '' }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <BookUploadModal v-if="uploadOpen" @close="closeUpload" @uploaded="closeUpload" />
</template>

<style scoped>
.cp-kbd {
  display: inline-flex;
  height: 1.25rem;
  min-width: 1.25rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
  border: 1px solid var(--shell-accent-line);
  padding: 0 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
}
</style>
