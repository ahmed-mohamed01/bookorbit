<script setup lang="ts">
// Fork: Convert to M4B. Left rail: library, scope tabs, search, and books grouped by author.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual'
import { ChevronDown, Library as LibraryIcon, Search, X } from '@lucide/vue'
import type { AudioConvertPlanStatus, AudioConvertPreviewItem, Library } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import SelectionCheckbox from '@/features/tools/bulk-rename/components/SelectionCheckbox.vue'
import type { AudioConvertScope } from '../composables/useAudioConvert'
import type { AudioConvertReviewGroup, TriState } from '../composables/useAudioConvertReview'
import AudioConvertSegmented from './AudioConvertSegmented.vue'

const props = defineProps<{
  libraries: Library[]
  library: Library | null
  scope: AudioConvertScope
  counts: Record<AudioConvertPlanStatus, number>
  search: string
  groups: AudioConvertReviewGroup[]
  collapsed: Set<string>
  currentId: number | null
  selectedCount: number
  selectionState: TriState
  hasMore: boolean
  loadingMore: boolean
  /** A scope or search change is loading page one; rows are replaced by placeholders of the same height. */
  loading: boolean
  isSelected: (item: AudioConvertPreviewItem) => boolean
  groupState: (key: string) => TriState
}>()

const emit = defineEmits<{
  'select-library': [libraryId: number]
  'update:scope': [scope: AudioConvertScope]
  'update:search': [value: string]
  select: [bookId: number]
  'toggle-selected': [item: AudioConvertPreviewItem]
  'toggle-group-selected': [key: string]
  'toggle-group': [key: string]
  'toggle-all': []
  'load-more': []
}>()

const { t } = useI18n()

const listRef = ref<HTMLElement | null>(null)

const selecting = computed(() => props.scope === 'can_convert')

type Row = { kind: 'header'; group: AudioConvertReviewGroup } | { kind: 'item'; item: AudioConvertPreviewItem; group: AudioConvertReviewGroup }

const HEADER_HEIGHT = 33
const ITEM_HEIGHT = 37

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const group of props.groups) {
    out.push({ kind: 'header', group })
    if (props.collapsed.has(group.key)) continue
    for (const item of group.items) out.push({ kind: 'item', item, group })
  }
  return out
})

const headerIndexes = computed(() => rows.value.reduce<number[]>((acc, row, index) => (row.kind === 'header' ? [...acc, index] : acc), []))
const activeHeaderIndex = ref(0)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => listRef.value,
    estimateSize: (index: number) => (rows.value[index]?.kind === 'header' ? HEADER_HEIGHT : ITEM_HEIGHT),
    overscan: 12,
    rangeExtractor: (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
      const pinned = [...headerIndexes.value].reverse().find((index) => index <= range.startIndex) ?? 0
      activeHeaderIndex.value = pinned
      return [...new Set([pinned, ...defaultRangeExtractor(range)])].sort((a, b) => a - b)
    },
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function rowAt(index: number): Row {
  return rows.value[index]!
}

function rowItem(index: number): AudioConvertPreviewItem {
  const row = rows.value[index]
  return row && row.kind === 'item' ? row.item : (undefined as unknown as AudioConvertPreviewItem)
}

function rowStyle(virtual: { index: number; start: number }): Record<string, string> {
  if (rows.value[virtual.index]?.kind === 'header' && activeHeaderIndex.value === virtual.index) {
    return { position: 'sticky', top: '0', zIndex: '2', width: '100%' }
  }
  return { position: 'absolute', top: '0', left: '0', width: '100%', transform: `translateY(${virtual.start}px)` }
}

function virtualRowKey(key: PropertyKey | bigint): PropertyKey {
  return typeof key === 'bigint' ? key.toString() : key
}

const scopeOptions = computed(() => [
  { value: 'can_convert' as const, label: t('audioConvert.scope.canConvert'), count: props.counts.can_convert },
  { value: 'waiting' as const, label: t('audioConvert.scope.waiting'), count: props.counts.waiting },
  { value: 'converted' as const, label: t('audioConvert.scope.converted'), count: props.counts.converted },
  { value: 'cannot' as const, label: t('audioConvert.scope.cannot'), count: props.counts.cannot },
])

function groupLabel(group: AudioConvertReviewGroup): string {
  return group.label || t('audioConvert.rail.unknownAuthor')
}

/** A short tag on the right of each row: what kind of conversion, or why not. */
function tagFor(item: AudioConvertPreviewItem): { text: string; tone: 'muted' | 'warning' | 'danger' | 'primary' } {
  if (item.status === 'cannot') return { text: t('audioConvert.tag.cannot'), tone: 'danger' }
  if (item.status === 'converted') return { text: 'M4B', tone: 'muted' }
  if (item.status === 'waiting') return { text: t('audioConvert.tag.waiting'), tone: 'primary' }
  if (item.fileCount > 1) return { text: t('audioConvert.tag.files', { count: item.fileCount }), tone: 'muted' }
  return { text: (item.formats[0] ?? '').toUpperCase(), tone: 'muted' }
}

function handleScope(value: AudioConvertScope): void {
  emit('update:scope', value)
}

function handleSearchInput(event: Event): void {
  emit('update:search', (event.target as HTMLInputElement).value)
}

function handleClearSearch(): void {
  emit('update:search', '')
}

function handleToggleAll(): void {
  emit('toggle-all')
}

function handleLoadMore(): void {
  emit('load-more')
}

function handleScroll(): void {
  const el = listRef.value
  if (!el || !props.hasMore || props.loadingMore) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) emit('load-more')
}

defineExpose({
  revealCurrent(): void {
    if (props.currentId === null) return
    const index = rows.value.findIndex((row) => row.kind === 'item' && row.item.bookId === props.currentId)
    if (index >= 0) virtualizer.value.scrollToIndex(index, { align: 'auto' })
  },
})
</script>

<template>
  <div class="flex min-h-0 flex-col border-e border-border bg-card/45">
    <div class="grid flex-none gap-2 border-b border-border p-3">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            class="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-2 text-start text-sm font-semibold shadow-xs transition-colors hover:border-primary/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span class="grid size-5.5 shrink-0 place-items-center rounded-[5px] bg-primary/12 text-primary">
              <LibraryIcon class="size-3" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ library?.name ?? t('audioConvert.rail.selectLibrary') }}</span>
            <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-(--reka-dropdown-menu-trigger-width)">
          <DropdownMenuItem v-for="option in libraries" :key="option.id" @select="emit('select-library', option.id)">
            <span class="min-w-0 flex-1 truncate">{{ option.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AudioConvertSegmented
        block
        :model-value="scope"
        :options="scopeOptions"
        :label="t('audioConvert.rail.scope')"
        @update:model-value="handleScope"
      />

      <div
        class="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-muted-foreground focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/35"
      >
        <Search class="size-3.5 shrink-0" aria-hidden="true" />
        <input
          :value="search"
          class="w-full min-w-0 border-0 bg-transparent text-sm text-foreground outline-none"
          :placeholder="t('audioConvert.rail.searchPlaceholder')"
          :aria-label="t('audioConvert.rail.searchLabel')"
          @input="handleSearchInput"
        />
        <button
          v-if="search"
          class="grid shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-label="t('audioConvert.rail.clearSearch')"
          @click="handleClearSearch"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- Always present in the Can convert scope so the list below never shifts when the count arrives. -->
    <div v-if="selecting" class="flex h-9 flex-none items-center gap-2 border-b border-border px-3">
      <SelectionCheckbox :state="selectionState" :label="t('audioConvert.rail.toggleAll')" @toggle="handleToggleAll" />
      <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
        {{ t('audioConvert.rail.selected', { count: selectedCount, total: counts.can_convert }) }}
      </span>
    </div>

    <div
      ref="listRef"
      class="min-h-0 flex-1 overflow-y-auto"
      role="listbox"
      :aria-label="t('audioConvert.rail.list')"
      :aria-activedescendant="currentId !== null ? `audio-convert-row-${currentId}` : undefined"
      tabindex="0"
      @scroll.passive="handleScroll"
    >
      <div v-if="loading && groups.length === 0" aria-hidden="true">
        <div v-for="n in 8" :key="n" class="flex h-[37px] items-center gap-2 border-b border-border/55 ps-8 pe-3">
          <Skeleton class="h-3.5 flex-1" />
          <Skeleton class="h-3.5 w-10" />
        </div>
      </div>

      <div v-else class="relative w-full" :style="{ height: `${totalSize}px` }">
        <template v-for="virtual in virtualRows" :key="virtualRowKey(virtual.key)">
          <div
            v-if="rowAt(virtual.index).kind === 'header'"
            :style="rowStyle(virtual)"
            class="grid h-[33px] grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur-sm"
          >
            <button
              class="grid size-4.5 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              :aria-expanded="!collapsed.has(rowAt(virtual.index).group.key)"
              :aria-label="
                collapsed.has(rowAt(virtual.index).group.key)
                  ? t('audioConvert.rail.expand', { author: groupLabel(rowAt(virtual.index).group) })
                  : t('audioConvert.rail.collapse', { author: groupLabel(rowAt(virtual.index).group) })
              "
              @click="emit('toggle-group', rowAt(virtual.index).group.key)"
            >
              <ChevronDown
                class="size-3.5 transition-transform"
                :class="{ '-rotate-90': collapsed.has(rowAt(virtual.index).group.key) }"
                aria-hidden="true"
              />
            </button>
            <SelectionCheckbox
              v-if="selecting"
              :state="groupState(rowAt(virtual.index).group.key)"
              :label="t('audioConvert.rail.toggleAuthor', { author: groupLabel(rowAt(virtual.index).group) })"
              @toggle="emit('toggle-group-selected', rowAt(virtual.index).group.key)"
            />
            <span v-else class="w-0" />
            <span class="truncate text-xs font-semibold" :title="groupLabel(rowAt(virtual.index).group)">
              {{ groupLabel(rowAt(virtual.index).group) }}
            </span>
            <span class="text-xs text-muted-foreground tabular-nums">{{ rowAt(virtual.index).group.items.length }}</span>
          </div>

          <div
            v-else
            :id="`audio-convert-row-${rowItem(virtual.index).bookId}`"
            :style="rowStyle(virtual)"
            class="grid h-[37px] cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-s-2 border-border/55 border-s-transparent ps-8 pe-3 text-start transition-colors hover:bg-muted"
            :class="{ 'border-s-primary bg-primary/12': currentId === rowItem(virtual.index).bookId }"
            role="option"
            :aria-selected="currentId === rowItem(virtual.index).bookId"
            @click="emit('select', rowItem(virtual.index).bookId)"
          >
            <SelectionCheckbox
              v-if="selecting"
              :state="isSelected(rowItem(virtual.index)) ? 'all' : 'none'"
              :label="t('audioConvert.rail.toggleBook', { title: rowItem(virtual.index).title })"
              @toggle="emit('toggle-selected', rowItem(virtual.index))"
            />
            <span v-else class="w-0" />
            <span
              class="truncate text-sm"
              :class="{
                'text-muted-foreground line-through': selecting && !isSelected(rowItem(virtual.index)),
                'font-semibold text-primary': currentId === rowItem(virtual.index).bookId,
              }"
            >
              {{ rowItem(virtual.index).title }}
            </span>
            <span
              class="rounded-xs border px-1.5 text-[0.6875rem] leading-4 whitespace-nowrap"
              :class="{
                'border-border text-muted-foreground': tagFor(rowItem(virtual.index)).tone === 'muted',
                'border-warning/40 text-warning': tagFor(rowItem(virtual.index)).tone === 'warning',
                'border-destructive/40 text-destructive': tagFor(rowItem(virtual.index)).tone === 'danger',
                'border-primary/40 text-primary': tagFor(rowItem(virtual.index)).tone === 'primary',
              }"
            >
              {{ tagFor(rowItem(virtual.index)).text }}
            </span>
          </div>
        </template>
      </div>

      <div v-if="hasMore" class="p-3">
        <Button variant="outline" size="sm" class="w-full" :disabled="loadingMore" @click="handleLoadMore">
          {{ loadingMore ? t('common.loading') : t('audioConvert.rail.loadMore') }}
        </Button>
      </div>

      <p v-else-if="groups.length === 0 && !loading" class="px-3 py-8 text-center text-sm text-muted-foreground">
        {{ search ? t('audioConvert.rail.noMatch') : t(`audioConvert.rail.empty.${scope}`) }}
      </p>
    </div>
  </div>
</template>
