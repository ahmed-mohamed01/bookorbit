<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronUp } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { WebSerialKind, WebSerialUnit } from '@bookorbit/types'
import { moveRadioChoice } from '../../lib/radioKeys'
import type { SerialRangeDraft } from '../../lib/serialSelection'
import { compareSequences, normalizeRange, ownedVolumes, sequenceInRange, unitsInSelection } from '../../lib/serialSelection'
import WebSerialUnitRow from './WebSerialUnitRow.vue'

const VIRTUAL_THRESHOLD = 40
const ROW_HEIGHT = 40
const SORT_STORAGE_KEY = 'bookorbit.webSerials.unitSort'

type UnitSort = 'newest' | 'oldest'

function readSort(): UnitSort {
  try {
    return localStorage.getItem(SORT_STORAGE_KEY) === 'oldest' ? 'oldest' : 'newest'
  } catch {
    return 'newest'
  }
}

const props = defineProps<{
  kind: WebSerialKind
  units: WebSerialUnit[]
  importedUnitKeys: string[]
  importedGroupKeys?: string[]
  range: SerialRangeDraft
  rangeIncludesImportedGap: boolean
  showVolumes?: boolean
  volumeOf?: (unit: WebSerialUnit) => string | null
}>()

const emit = defineEmits<{
  'set-mode': [mode: SerialRangeDraft['mode']]
  'select-unit': [sequence: string]
  'select-latest': []
  'select-first': []
  'select-missing': []
  'clear-range': []
}>()

const { t } = useI18n()
const scrollElement = ref<HTMLElement | null>(null)
const sort = ref<UnitSort>(readSort())
const peeked = ref<string | null>(null)
const expanded = ref(false)
const displayUnits = computed(() => {
  const ascending = [...props.units].sort((a, b) => compareSequences(a.sequence, b.sequence))
  return sort.value === 'newest' ? ascending.reverse() : ascending
})
const imported = computed(() => {
  const owned = new Set(props.importedUnitKeys)
  const volumeOf = props.volumeOf
  if (!props.showVolumes || !volumeOf || !props.importedGroupKeys?.length) return owned
  const volumes = ownedVolumes(props.units, volumeOf, props.importedGroupKeys)
  for (const unit of props.units) {
    const volume = volumeOf(unit)
    if (volume !== null && volumes.has(volume)) owned.add(unit.key)
  }
  return owned
})
const virtualized = computed(() => props.kind === 'manga' && displayUnits.value.length >= VIRTUAL_THRESHOLD)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: virtualized.value ? displayUnits.value.length : 0,
    getScrollElement: () => scrollElement.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index: number) => displayUnits.value[index]?.key ?? index,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
const missingCount = computed(() => props.units.filter((unit) => !imported.value.has(unit.key)).length)
const choosing = computed(() => props.range.mode === 'range')
const listVisible = computed(() => choosing.value || expanded.value)
const totalChapters = computed(() => props.units.reduce((sum, unit) => sum + unit.chapterCount, 0))
const ownedCount = computed(() => props.units.filter((unit) => imported.value.has(unit.key)).length)
const allSummary = computed(() => t(`webSerials.preview.allSummary.${props.kind}`, { count: props.units.length, chapters: totalChapters.value }))
const toggleListLabel = computed(() => (expanded.value ? t('webSerials.preview.hideList') : t(`webSerials.preview.showList.${props.kind}`)))

watch(
  () => props.units,
  () => {
    expanded.value = false
    peeked.value = null
  },
)
const anchor = computed(() => (choosing.value && props.range.fromSequence && !props.range.toSequence ? props.range.fromSequence : null))
const committed = computed(() => choosing.value && !!props.range.fromSequence && !!props.range.toSequence)
const previewDraft = computed<SerialRangeDraft | null>(() => {
  if (!anchor.value || !peeked.value) return null
  return { mode: 'range', fromSequence: anchor.value, toSequence: peeked.value }
})
const previewKeys = computed(() => {
  if (!previewDraft.value) return new Set<string>()
  return new Set(unitsInSelection(props.units, previewDraft.value).map((unit) => unit.sequence))
})
const summaryDraft = computed(() => previewDraft.value ?? (committed.value ? props.range : null))
const rangeSummary = computed(() => {
  const draft = summaryDraft.value
  if (!draft) return null
  const { from, to } = normalizeRange(draft)
  return t(`webSerials.preview.rangeSummary.${props.kind}`, { from, to, count: unitsInSelection(props.units, draft).length })
})
const hint = computed(() => {
  if (!choosing.value || committed.value) return null
  return t(`webSerials.preview.rangeHint.${anchor.value ? 'anchor' : 'idle'}.${props.kind}`)
})
const sortLabel = computed(() => t(`webSerials.preview.sort.${props.kind}.${sort.value}`))
const sortTitle = computed(() => t('webSerials.preview.sort.toggle'))

function rowStyle(start: number): Record<string, string> {
  return { position: 'absolute', top: '0', left: '0', width: '100%', transform: `translateY(${start}px)` }
}

function selectAll() {
  emit('set-mode', 'all')
}

function chooseRange() {
  emit('set-mode', 'range')
}

function selectUnit(sequence: string) {
  emit('select-unit', sequence)
}

function selectLatest() {
  emit('select-latest')
}

function selectFirst() {
  emit('select-first')
}

function selectMissing() {
  emit('select-missing')
}

function clearRange() {
  emit('clear-range')
}

function volumeFor(unit: WebSerialUnit): string | null | undefined {
  return props.showVolumes ? (props.volumeOf?.(unit) ?? null) : undefined
}

function isSelected(unit: WebSerialUnit): boolean {
  return sequenceInRange(unit.sequence, props.range)
}

function isPreviewed(unit: WebSerialUnit): boolean {
  return previewKeys.value.has(unit.sequence)
}

function isAnchor(unit: WebSerialUnit): boolean {
  return anchor.value === unit.sequence
}

function markFor(unit: WebSerialUnit): 'start' | 'end' | null {
  if (isAnchor(unit)) return 'start'
  if (!committed.value) return null
  const { from, to } = normalizeRange(props.range)
  if (unit.sequence === from) return 'start'
  return unit.sequence === to ? 'end' : null
}

function toggleList() {
  expanded.value = !expanded.value
}

function toggleSort() {
  sort.value = sort.value === 'newest' ? 'oldest' : 'newest'
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort.value)
  } catch {
    /* preference stays in memory */
  }
}

function peekUnit(sequence: string) {
  peeked.value = sequence
}

function dropPeek() {
  peeked.value = null
}

function handleFocusOut(event: FocusEvent) {
  const next = event.relatedTarget
  if (!(next instanceof Node) || !scrollElement.value?.contains(next)) dropPeek()
}

function moveFocus(step: 1 | -1) {
  const rows = Array.from(scrollElement.value?.querySelectorAll<HTMLButtonElement>('button[data-unit-row]') ?? [])
  const current = rows.findIndex((row) => row === document.activeElement)
  const target = rows[current === -1 ? 0 : current + step]
  target?.focus()
}

function handleModeKeydown(event: KeyboardEvent) {
  moveRadioChoice(event)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && anchor.value) {
    event.preventDefault()
    dropPeek()
    clearRange()
    return
  }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target instanceof HTMLElement && event.target.hasAttribute('data-unit-row')) {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1)
  }
}
</script>

<template>
  <div class="space-y-2.5" @keydown="handleKeydown">
    <div class="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        :aria-label="t('webSerials.preview.rangeLabel')"
        class="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5"
        @keydown="handleModeKeydown"
      >
        <button
          type="button"
          role="radio"
          class="rounded-md px-3 py-0.5 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :class="range.mode === 'all' ? 'bg-background text-primary shadow-xs' : 'text-foreground hover:bg-background/60'"
          :aria-checked="range.mode === 'all'"
          :tabindex="range.mode === 'all' ? 0 : -1"
          @click="selectAll"
        >
          {{ t('webSerials.preview.rangeAll') }}
        </button>
        <button
          type="button"
          role="radio"
          class="rounded-md px-3 py-0.5 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :class="range.mode === 'range' ? 'bg-background text-primary shadow-xs' : 'text-foreground hover:bg-background/60'"
          :aria-checked="range.mode === 'range'"
          :tabindex="range.mode === 'range' ? 0 : -1"
          @click="chooseRange"
        >
          {{ t('webSerials.preview.rangeSome') }}
        </button>
      </div>
      <button
        v-if="listVisible"
        type="button"
        class="ms-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :title="sortTitle"
        data-testid="unit-sort"
        @click="toggleSort"
      >
        <ArrowDownWideNarrow v-if="sort === 'newest'" :size="14" aria-hidden="true" />
        <ArrowUpNarrowWide v-else :size="14" aria-hidden="true" />
        {{ sortLabel }}
      </button>
    </div>

    <template v-if="range.mode === 'range'">
      <div class="flex flex-wrap gap-1.5">
        <button
          type="button"
          class="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          @click="selectLatest"
        >
          {{ t('webSerials.preview.quick.latest') }}
        </button>
        <button
          type="button"
          class="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          @click="selectFirst"
        >
          {{ t('webSerials.preview.quick.first') }}
        </button>
        <button
          type="button"
          class="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="missingCount === 0"
          @click="selectMissing"
        >
          {{ t('webSerials.preview.quick.notInLibrary') }}
        </button>
      </div>

      <p v-if="hint" class="text-xs text-muted-foreground" aria-live="polite" data-testid="range-hint">{{ hint }}</p>
      <div v-if="rangeSummary" class="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
        <p class="font-medium text-foreground" data-testid="range-summary">
          {{ rangeSummary }}
          <span v-if="rangeIncludesImportedGap && !previewDraft" class="font-normal text-muted-foreground">
            · {{ t('webSerials.preview.rangeSummary.includesOwned') }}
          </span>
        </p>
        <button type="button" class="font-medium text-primary hover:underline" @click="clearRange">
          {{ t('webSerials.preview.clearRange') }}
        </button>
      </div>
      <button v-else-if="anchor" type="button" class="text-xs font-medium text-primary hover:underline" @click="clearRange">
        {{ t('webSerials.preview.clearRange') }}
      </button>
    </template>

    <div v-if="range.mode === 'all'" class="flex flex-wrap items-center gap-2 text-xs" data-testid="all-summary">
      <p class="font-medium text-foreground">
        {{ allSummary }}
        <span v-if="ownedCount > 0" class="font-normal text-muted-foreground">
          · {{ t('webSerials.preview.alreadyInLibrary', { count: ownedCount }) }}
        </span>
      </p>
      <button
        type="button"
        class="ms-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :aria-expanded="expanded"
        data-testid="toggle-list"
        @click="toggleList"
      >
        <ChevronUp v-if="expanded" :size="14" aria-hidden="true" />
        <ChevronDown v-else :size="14" aria-hidden="true" />
        {{ toggleListLabel }}
      </button>
    </div>

    <div
      v-if="listVisible"
      ref="scrollElement"
      class="max-h-70 overflow-y-auto rounded-lg border border-border bg-background"
      role="list"
      @pointerleave="dropPeek"
      @focusout="handleFocusOut"
      :aria-label="t(`webSerials.preview.listLabel.${kind}`)"
    >
      <div v-if="virtualized" class="relative w-full" :style="{ height: `${totalSize}px` }">
        <div
          v-for="row in virtualRows"
          :key="String(row.key)"
          role="listitem"
          class="border-b border-border last:border-b-0"
          :style="rowStyle(row.start)"
        >
          <WebSerialUnitRow
            v-if="displayUnits[row.index]"
            :unit="displayUnits[row.index]!"
            :kind="kind"
            :imported="imported.has(displayUnits[row.index]!.key)"
            :selected="isSelected(displayUnits[row.index]!)"
            :previewed="isPreviewed(displayUnits[row.index]!)"
            :anchor="isAnchor(displayUnits[row.index]!)"
            :mark="markFor(displayUnits[row.index]!)"
            :volume="volumeFor(displayUnits[row.index]!)"
            :choosing="choosing"
            @select="selectUnit"
            @peek="peekUnit"
          />
        </div>
      </div>
      <div v-else>
        <div v-for="unit in displayUnits" :key="unit.key" role="listitem" class="border-b border-border last:border-b-0">
          <WebSerialUnitRow
            :unit="unit"
            :kind="kind"
            :imported="imported.has(unit.key)"
            :selected="isSelected(unit)"
            :previewed="isPreviewed(unit)"
            :anchor="isAnchor(unit)"
            :mark="markFor(unit)"
            :volume="volumeFor(unit)"
            :choosing="choosing"
            @select="selectUnit"
            @peek="peekUnit"
          />
        </div>
      </div>
    </div>
  </div>
</template>
