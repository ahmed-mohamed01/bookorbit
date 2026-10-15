<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Info, Link2, Loader2, Rows3, Search, StretchHorizontal, TriangleAlert } from '@lucide/vue'
import type { WebSerialCatalogEntry, WebSerialSearchHit, WebSerialSeriesDetail, WebSerialSuggestion } from '@bookorbit/types'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import type { WebSerialSearchScope } from '../api/webSerials'
import { hitIdentity, useWebSerialSearch, type WebSerialSearchKind } from '../composables/useWebSerialSearch'
import { useWebSerialSearchUrl } from '../composables/useWebSerialSearchUrl'
import { useWebSerialSuggest } from '../composables/useWebSerialSuggest'
import { suggestionOptionId } from '../lib/serialSuggest'
import { CATALOG_SORTS, RESULT_DENSITIES, RESULT_SORTS, type WebSerialResultDensity, type WebSerialResultSort } from '../lib/serialPresentation'
import WebSerialCatalogRow from './WebSerialCatalogRow.vue'
import WebSerialResultRow from './WebSerialResultRow.vue'
import WebSerialSourceFilter from './WebSerialSourceFilter.vue'
import WebSerialSuggestions from './WebSerialSuggestions.vue'

type PreviewTarget = { kind: 'link'; url: string } | { kind: 'hit'; hit: WebSerialSearchHit }

const props = defineProps<{
  /** The signed-in user, who owns the stored search. */
  userId?: number | null
  /** Holds app settings, so the not-set-up state can link to the setup page. */
  canSetUp?: boolean
}>()

const emit = defineEmits<{
  open: [detail: WebSerialSeriesDetail]
  'open-entry': [entry: WebSerialCatalogEntry]
  'open-suggestion': [suggestion: WebSerialSuggestion]
  'preview-loading': []
  'preview-error': [message: string]
  /** The server is still loading a long chapter list for the preview; `source` is null for a pasted link. */
  'preview-pending': [source: string | null]
  'novel-available': [value: boolean]
}>()

const { t } = useI18n()
const notReadyHint = computed(() => (props.canSetUp ? t('webSerials.notReady.adminBody') : t('webSerials.notReady.body')))
const settingsRoute = { name: 'settings-admin-web-serials' }
const search = useWebSerialSearch()
const searchUrl = useWebSerialSearchUrl(
  search,
  computed(() => props.userId ?? null),
)
const {
  query,
  scope,
  hits,
  visibleHits,
  showMachineTranslations,
  hasMtlHits,
  resultSort,
  resultDensity,
  mode,
  entries,
  visibleEntries,
  catalogSort,
  discovering,
  fallbackReason,
  canReturnToSeries,
  sourceOptions,
  activeSource,
  failedSources,
  novelSourcesDisabled,
  capabilities,
  pendingKinds,
  searching,
  resolvingLink,
  openingKey,
  hasSearched,
  fetchedAt,
  refreshing,
  refreshFailed,
  searchError,
  previewError,
  capabilitiesFailed,
  previewPending,
  isLink,
  canSubmit,
  novelLinksOnly,
  availableScopes,
  nothingAvailable,
} = search

const suggestEnabled = computed(
  () => (scope.value === 'novel' || scope.value === 'all') && (capabilities.value?.novel.available ?? false) && !nothingAvailable.value,
)
const queryFocused = ref(false)
const suggest = useWebSerialSuggest(query, suggestEnabled, queryFocused)
const { suggestions, visible: suggestionsOpen, highlighted } = suggest
const activeOptionId = computed(() => (suggestionsOpen.value && highlighted.value >= 0 ? suggestionOptionId(highlighted.value) : undefined))

const lastPreviewTarget = ref<PreviewTarget | null>(null)
const busy = computed(() => searching.value || resolvingLink.value)
const placeholder = computed(() => (novelLinksOnly.value ? t('webSerials.search.placeholderLinksOnly') : t('webSerials.search.placeholder')))
const submitLabel = computed(() => (isLink.value ? t('webSerials.search.openLink') : t('webSerials.search.submit')))
const showScopes = computed(() => availableScopes.value.length > 1)
const failedLabel = computed(() => t('webSerials.results.failedSources', { count: failedSources.value.length }))
const seriesMode = computed(() => mode.value === 'series')
const showEmpty = computed(() => !seriesMode.value && hasSearched.value && !searching.value && !searchError.value && hits.value.length === 0)
const showSeries = computed(() => seriesMode.value && !discovering.value && entries.value.length > 0)
const sortOptions = computed<readonly WebSerialResultSort[]>(() => (seriesMode.value ? CATALOG_SORTS : RESULT_SORTS))
const sortValue = computed(() => (seriesMode.value ? catalogSort.value : resultSort.value))
const fallbackNotice = computed(() => (fallbackReason.value ? t(`webSerials.discover.series.fallback.${fallbackReason.value}`) : null))
const skeletonRows = computed(() => (pendingKinds.value.length > 1 ? 2 : 4))
const showResultControls = computed(() => (seriesMode.value ? entries.value.length > 0 : visibleHits.value.length > 0))
const compactList = computed(() => resultDensity.value === 'compact')
const now = ref(Date.now())
const hasResults = computed(() => (seriesMode.value ? entries.value.length > 0 : visibleHits.value.length > 0))
const showAge = computed(() => fetchedAt.value !== null && !searching.value && !searchError.value && hasResults.value)
const ageLabel = computed(() => {
  const minutes = fetchedAt.value === null ? 0 : Math.max(0, Math.floor((now.value - fetchedAt.value) / 60_000))
  return t('webSerials.results.fromMinutesAgo', { count: minutes })
})
let ageTimer: ReturnType<typeof setInterval> | null = null

watch(previewPending, (pending) => {
  if (pending) emit('preview-pending', pending.source)
})

watch(
  () => capabilities.value?.novel.available ?? false,
  (value) => emit('novel-available', value),
  { immediate: true },
)

onMounted(async () => {
  ageTimer = setInterval(tickAge, 30_000)
  await search.loadCapabilities()
  await searchUrl.restore()
})

onBeforeUnmount(() => {
  if (ageTimer !== null) clearInterval(ageTimer)
  search.dispose()
})

function tickAge() {
  now.value = Date.now()
}

let previewSeq = 0

async function openPreview(target: PreviewTarget) {
  const mine = ++previewSeq
  lastPreviewTarget.value = target
  search.clearPreviewError()
  emit('preview-loading')
  let detail: WebSerialSeriesDetail | null
  if (target.kind === 'hit') detail = await search.openHit(target.hit)
  else {
    query.value = target.url
    detail = await search.submit()
  }
  // A later preview replaced this one while it loaded.
  if (mine !== previewSeq) return
  if (detail) emit('open', detail)
  else emit('preview-error', previewError.value ?? t('webSerials.preview.loadError'))
}

async function handleSubmit(event: Event) {
  event.preventDefault()
  suggest.settle()
  if (isLink.value) {
    await openPreview({ kind: 'link', url: query.value.trim() })
    return
  }
  const text = query.value.trim()
  await search.submit()
  searchUrl.commit(text)
}

function handleQueryKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (suggestions.value.length === 0) return
    event.preventDefault()
    suggest.move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Escape' && suggestionsOpen.value) {
    event.preventDefault()
    suggest.close()
    return
  }
  if (event.key === 'Enter' && suggestionsOpen.value && suggest.active.value) {
    event.preventDefault()
    chooseSuggestion(suggest.active.value)
  }
}

function handleQueryFocus() {
  queryFocused.value = true
}

function handleQueryBlur() {
  queryFocused.value = false
  suggest.close()
}

function handleSuggestionHighlight(index: number) {
  suggest.highlight(index)
}

function handleSuggestionChoose(suggestion: WebSerialSuggestion) {
  chooseSuggestion(suggestion)
}

function chooseSuggestion(suggestion: WebSerialSuggestion) {
  query.value = suggestion.title
  suggest.settle(suggestion.title)
  if (suggestion.entries.length > 0) emit('open-suggestion', suggestion)
}

function handleOpenHit(hit: WebSerialSearchHit) {
  void openPreview({ kind: 'hit', hit })
}

function retryPreview() {
  if (lastPreviewTarget.value) void openPreview(lastPreviewTarget.value)
}

function handleOpenEntry(entry: WebSerialCatalogEntry) {
  emit('open-entry', entry)
}

async function handleSearchSites() {
  const text = query.value.trim()
  await search.searchSites()
  searchUrl.commit(text)
}

function handleBackToSeries() {
  search.backToSeries()
  searchUrl.syncFilters()
}

async function handleRetrySearch() {
  const text = query.value.trim()
  await search.submit()
  searchUrl.commit(text)
}

function handleScope(next: WebSerialSearchScope) {
  search.setScope(next)
  void searchUrl.rescope()
}

function handleSource(next: string | null) {
  search.setSource(next)
  searchUrl.syncFilters()
}

function handleShowMtl(event: Event) {
  search.setShowMachineTranslations((event.target as HTMLInputElement).checked)
  searchUrl.persist()
}

async function handleRefresh() {
  tickAge()
  await searchUrl.refresh()
  tickAge()
}

function handleSort(value: string | number) {
  search.setResultSort(String(value) as WebSerialResultSort)
}

function handleDensity(next: WebSerialResultDensity) {
  search.setResultDensity(next)
}

function sortLabel(value: WebSerialResultSort): string {
  return t(`webSerials.results.sort.${value}`)
}

function densityLabel(value: WebSerialResultDensity): string {
  return t(`webSerials.results.density.${value}`)
}

function scopeLabel(value: WebSerialSearchScope): string {
  return value === 'all' ? t('webSerials.search.scope.all') : t(`webSerials.search.scope.${value}`)
}

function pendingHeading(kind: WebSerialSearchKind): string {
  return t(`webSerials.discover.pendingHeading.${kind}`)
}

function pendingLabel(kind: WebSerialSearchKind): string {
  return t(`webSerials.discover.stillSearching.${kind}`)
}

function isOpening(hit: WebSerialSearchHit): boolean {
  return openingKey.value === hitIdentity(hit)
}

async function searchSitesFor(title: string) {
  await search.searchSites(title)
  searchUrl.commit(title.trim())
}

function cancelPreview() {
  search.cancelPreview()
}

defineExpose({ retryPreview, searchSitesFor, cancelPreview })
</script>

<template>
  <div class="space-y-5">
    <form @submit="handleSubmit">
      <div class="rounded-xl border border-border bg-card shadow-xs">
        <div class="flex flex-col gap-2.5 p-3 sm:flex-row sm:items-center">
          <div class="relative w-full sm:flex-1">
            <div
              class="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40"
            >
              <Link2 v-if="isLink" :size="15" class="shrink-0 text-primary" aria-hidden="true" />
              <Search v-else :size="15" class="shrink-0 text-muted-foreground" aria-hidden="true" />
              <label for="web-serials-query" class="sr-only">{{ t('webSerials.search.label') }}</label>
              <input
                id="web-serials-query"
                v-model="query"
                type="text"
                inputmode="search"
                autocomplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="web-serials-suggestions"
                :aria-expanded="suggestionsOpen"
                :aria-activedescendant="activeOptionId"
                class="h-full w-full min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
                :placeholder="placeholder"
                :disabled="nothingAvailable"
                @keydown="handleQueryKeydown"
                @focus="handleQueryFocus"
                @blur="handleQueryBlur"
              />
            </div>
            <WebSerialSuggestions
              id="web-serials-suggestions"
              :suggestions="suggestions"
              :open="suggestionsOpen"
              :highlighted="highlighted"
              @highlight="handleSuggestionHighlight"
              @choose="handleSuggestionChoose"
            />
          </div>
          <Button type="submit" class="w-full sm:w-auto sm:shrink-0" :disabled="!canSubmit || nothingAvailable">
            <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
            {{ submitLabel }}
          </Button>
        </div>

        <div class="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-border bg-muted px-3 py-2.5">
          <fieldset v-if="showScopes" class="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
            <legend class="sr-only">{{ t('webSerials.search.scopeLabel') }}</legend>
            <button
              v-for="option in availableScopes"
              :key="option"
              type="button"
              class="shrink-0 rounded-md px-3 py-1 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
              :class="scope === option ? 'bg-background text-primary shadow-xs' : 'text-foreground hover:bg-background/60'"
              :aria-pressed="scope === option"
              @click="handleScope(option)"
            >
              {{ scopeLabel(option) }}
            </button>
          </fieldset>
          <p class="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link2 :size="13" class="shrink-0" aria-hidden="true" />
            {{ t('webSerials.discover.linkHint') }}
          </p>
          <p v-if="novelLinksOnly" class="basis-full text-xs text-muted-foreground">{{ t('webSerials.search.novelLinksHint') }}</p>
        </div>
      </div>
    </form>

    <EmptyState
      v-if="capabilitiesFailed"
      icon="TriangleAlert"
      :title="t('webSerials.discover.capabilitiesErrorTitle')"
      :hint="t('webSerials.errors.capabilities')"
    />

    <EmptyState v-else-if="nothingAvailable" icon="Globe" :title="t('webSerials.notReady.title')" :hint="notReadyHint">
      <template v-if="canSetUp" #actions>
        <Button as-child variant="outline" size="sm">
          <RouterLink :to="settingsRoute" data-testid="not-ready-settings">{{ t('webSerials.notReady.adminAction') }}</RouterLink>
        </Button>
      </template>
    </EmptyState>

    <EmptyState v-else-if="searchError" icon="TriangleAlert" :title="t('webSerials.discover.searchErrorTitle')" :hint="searchError">
      <template #actions>
        <Button variant="outline" size="sm" @click="handleRetrySearch">{{ t('common.retry') }}</Button>
      </template>
    </EmptyState>

    <p v-if="!seriesMode && novelSourcesDisabled" class="flex items-start gap-2 text-xs text-muted-foreground">
      <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
      {{ t('errors.codes.WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED') }}
    </p>

    <p v-if="!seriesMode && failedSources.length > 0" class="flex items-start gap-2 text-xs text-muted-foreground">
      <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
      {{ failedLabel }}
      <button
        type="button"
        class="rounded-md font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
        :disabled="refreshing"
        @click="handleRefresh"
      >
        {{ t('webSerials.results.retryFailed') }}
      </button>
    </p>

    <p v-if="fallbackNotice" class="flex items-start gap-2 text-xs text-muted-foreground" data-testid="fallback-notice">
      <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {{ fallbackNotice }}
    </p>

    <p v-if="showAge" class="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground" data-testid="results-age">
      <span>{{ refreshing ? t('webSerials.results.refreshing') : ageLabel }}</span>
      <span v-if="refreshFailed" class="text-warning">{{ t('webSerials.results.refreshFailed') }}</span>
      <button
        type="button"
        class="rounded-md font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
        :disabled="refreshing"
        @click="handleRefresh"
      >
        {{ t('webSerials.results.refresh') }}
      </button>
    </p>

    <button
      v-if="canReturnToSeries"
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      @click="handleBackToSeries"
    >
      <ArrowLeft class="size-3.5 rtl:rotate-180" aria-hidden="true" />
      {{ t('webSerials.discover.series.backToSeries') }}
    </button>

    <WebSerialSourceFilter
      v-if="!seriesMode && sourceOptions.length > 1"
      :options="sourceOptions"
      :selected="activeSource"
      :total="hits.length"
      @select="handleSource"
    />

    <label v-if="!seriesMode && hasMtlHits" class="flex w-fit items-center gap-2 text-xs text-foreground" data-testid="mtl-toggle">
      <input type="checkbox" class="size-4 accent-primary" :checked="showMachineTranslations" @change="handleShowMtl" />
      {{ t('webSerials.results.showMachineTranslations') }}
    </label>

    <div v-if="showResultControls" class="flex flex-wrap items-center gap-2" data-testid="result-controls">
      <label class="flex items-center gap-1.5">
        <span class="text-xs whitespace-nowrap text-muted-foreground">{{ t('webSerials.results.sort.label') }}</span>
        <Select class="h-8 w-auto min-w-[8rem] text-[12.5px]" :model-value="sortValue" @update:model-value="handleSort">
          <option v-for="option in sortOptions" :key="option" :value="option">{{ sortLabel(option) }}</option>
        </Select>
      </label>
      <fieldset class="ms-auto inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
        <legend class="sr-only">{{ t('webSerials.results.density.label') }}</legend>
        <button
          v-for="option in RESULT_DENSITIES"
          :key="option"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
          :class="resultDensity === option ? 'bg-background text-primary shadow-xs' : 'text-foreground hover:bg-background/60'"
          :aria-pressed="resultDensity === option"
          :aria-label="densityLabel(option)"
          :title="densityLabel(option)"
          @click="handleDensity(option)"
        >
          <StretchHorizontal v-if="option === 'comfortable'" :size="14" aria-hidden="true" />
          <Rows3 v-else :size="14" aria-hidden="true" />
          <span class="hidden sm:inline">{{ densityLabel(option) }}</span>
        </button>
      </fieldset>
    </div>

    <template v-if="showSeries">
      <ul :class="compactList ? 'space-y-1' : 'space-y-2'" :aria-label="t('webSerials.results.label')" data-testid="series-results">
        <WebSerialCatalogRow
          v-for="entry in visibleEntries"
          :key="`${entry.kind}:${entry.matchId}`"
          :entry="entry"
          :density="resultDensity"
          @open="handleOpenEntry"
        />
      </ul>
      <p class="flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
        {{ t('webSerials.discover.series.searchSitesLead') }}
        <button
          type="button"
          class="rounded-md font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          @click="handleSearchSites"
        >
          {{ t('webSerials.discover.series.searchSites') }}
        </button>
      </p>
    </template>

    <section v-if="discovering" data-testid="pending-series" :aria-label="t('webSerials.discover.series.heading')">
      <div class="space-y-2" aria-hidden="true">
        <div v-for="index in 4" :key="index" class="flex animate-pulse items-center gap-3 rounded-lg border border-border bg-card p-3">
          <div class="h-[74px] w-[50px] shrink-0 rounded-sm bg-muted" />
          <div class="min-w-0 flex-1 space-y-2">
            <div class="h-4 w-2/5 rounded bg-muted" />
            <div class="h-3 w-1/4 rounded bg-muted" />
            <div class="h-3 w-3/5 rounded bg-muted" />
          </div>
        </div>
      </div>
      <p class="mt-2 text-xs text-muted-foreground" role="status">{{ t('webSerials.discover.series.stillSearching') }}</p>
    </section>

    <ul v-if="!seriesMode && visibleHits.length > 0" :class="compactList ? 'space-y-1' : 'space-y-2'" :aria-label="t('webSerials.results.label')">
      <WebSerialResultRow
        v-for="hit in visibleHits"
        :key="hitIdentity(hit)"
        :hit="hit"
        :density="resultDensity"
        :opening="isOpening(hit)"
        :disabled="openingKey !== null"
        @open="handleOpenHit"
      />
    </ul>

    <section v-for="kind in pendingKinds" :key="kind" :data-testid="`pending-${kind}`" :aria-label="pendingHeading(kind)">
      <div class="mb-3 flex items-center gap-2">
        <h2 class="text-xs font-semibold text-foreground">{{ pendingHeading(kind) }}</h2>
        <div class="h-px flex-1 bg-border" />
      </div>
      <div class="space-y-2" aria-hidden="true">
        <div v-for="index in skeletonRows" :key="index" class="flex animate-pulse items-center gap-3 rounded-lg border border-border bg-card p-3">
          <div class="h-[74px] w-[50px] shrink-0 rounded-sm bg-muted" />
          <div class="min-w-0 flex-1 space-y-2">
            <div class="h-4 w-2/5 rounded bg-muted" />
            <div class="h-3 w-1/4 rounded bg-muted" />
            <div class="h-3 w-3/5 rounded bg-muted" />
          </div>
          <div class="h-8 w-16 rounded-md bg-muted" />
        </div>
      </div>
      <p class="mt-2 text-xs text-muted-foreground" role="status">{{ pendingLabel(kind) }}</p>
    </section>

    <EmptyState v-if="showEmpty" icon="SearchX" :title="t('webSerials.results.emptyTitle')" :hint="t('webSerials.results.emptyBody')" />

    <div v-else-if="!hasSearched && !searching && !nothingAvailable && !capabilitiesFailed" class="px-1 text-sm text-muted-foreground">
      {{ t('webSerials.search.intro') }}
    </div>
  </div>
</template>
