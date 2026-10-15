<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Download, ExternalLink, Link2, Loader2, TriangleAlert } from '@lucide/vue'
import { baseSeriesDisplayTitle, baseSeriesTitle } from '@bookorbit/types'
import type { WebSerialCatalogEntry, WebSerialJob, WebSerialPackaging, WebSerialSeriesDetail, WebSerialSuggestion } from '@bookorbit/types'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/composables/useAuth'
import { formatNumber, formatRelativeFromNow } from '@/i18n/formatters'
import { matchOfEntry, useWebSerialEntryPreview } from '../composables/useWebSerialEntryPreview'
import { useWebSerialJobForm } from '../composables/useWebSerialJobForm'
import { useWebSerialLookup } from '../composables/useWebSerialLookup'
import { useWebSerialSeriesSwitch } from '../composables/useWebSerialSeriesSwitch'
import { useWebSerialSources } from '../composables/useWebSerialSources'
import WebSerialCover from './WebSerialCover.vue'
import WebSerialEntryPreview from './WebSerialEntryPreview.vue'
import type { PublishedSeries } from '../lib/publishedVolumes'
import WebSerialCredits from './preview/WebSerialCredits.vue'
import WebSerialPublishedDisclosure from './preview/WebSerialPublishedDisclosure.vue'
import WebSerialSources from './preview/WebSerialSources.vue'
import WebSerialSynopsis from './preview/WebSerialSynopsis.vue'
import WebSerialTags from './preview/WebSerialTags.vue'
import WebSerialUnitPicker from './preview/WebSerialUnitPicker.vue'
import WebSerialVolumeNotice from './preview/WebSerialVolumeNotice.vue'

const props = withDefaults(
  defineProps<{
    detail: WebSerialSeriesDetail | null
    /** A series opened from the series database: its sources are searched and the most complete one opens as the detail. */
    entry?: WebSerialCatalogEntry | null
    /** A light novel chosen from the search box: every copy it lists is offered under "Download from", one is opened at once. */
    suggestion?: WebSerialSuggestion | null
    open: boolean
    loading?: boolean
    loadError?: string | null
    /** Shown while the server is still loading a long chapter list for the series being opened. */
    loadingNotice?: string | null
  }>(),
  { entry: null, suggestion: null, loading: false, loadError: null, loadingNotice: null },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  created: [job: WebSerialJob]
  retry: []
  'search-sites': [title: string]
}>()

const { t } = useI18n()
const { user } = useAuth()
const userId = computed(() => user.value?.id ?? null)
const entryRef = computed(() => props.entry)
const suggestionRef = computed(() => props.suggestion)
const openRef = computed(() => props.open)
const entryPreview = useWebSerialEntryPreview(entryRef, suggestionRef, openRef)
const fromDiscover = computed(() => props.entry !== null || props.suggestion !== null)
// Reopening the same series keeps a fresh answer; a stale one, or a check that found nothing or failed, is asked again.
const REOPEN_FRESH_MS = 60_000
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      seriesSwitch.cancel()
      return
    }
    if (fromDiscover.value) void entryPreview.refreshIfStale(REOPEN_FRESH_MS)
  },
)
const openedDetail = computed(() => props.detail ?? entryPreview.detail.value)
const presetMatch = computed(() => (props.entry ? matchOfEntry(props.entry) : null))
const entryMatchId = computed(() => props.entry?.matchId ?? null)
const seriesSwitch = useWebSerialSeriesSwitch(openedDetail, entryMatchId)
const { shown, switching, switchError, renderKey: sourcesRenderKey, select: selectSource } = seriesSwitch
const openedKey = computed(() => props.detail?.seriesKey ?? null)
const sources = useWebSerialSources(openedKey)
const credits = useWebSerialLookup(shown, presetMatch)
const sourceOptions = computed(() => (fromDiscover.value ? entryPreview.options.value : sources.options.value))
const sourcesState = computed(() => (fromDiscover.value ? 'ready' : sources.state.value))
// A suggestion the series database does not know has no entry to show while its first copy opens.
const suggestionOpening = computed(
  () =>
    props.suggestion !== null && props.entry === null && !shown.value && entryPreview.state.value !== 'error' && entryPreview.state.value !== 'none',
)
const suggestionError = computed(() =>
  props.suggestion !== null && props.entry === null && !shown.value && entryPreview.state.value === 'error' ? entryPreview.error.value : null,
)
const showLoading = computed(() => props.loading || suggestionOpening.value)
const shownLoadError = computed(() => props.loadError ?? suggestionError.value)
const coverSrc = computed(() => props.entry?.coverUrl ?? shown.value?.coverUrl ?? null)
const form = useWebSerialJobForm(shown, { chapterVolumes: credits.chapterVolumes, loading: credits.loading }, userId)
const seriesLoadingNotice = computed(() => {
  if (props.loadingNotice) return props.loadingNotice
  const source = entryPreview.pendingSource.value ?? seriesSwitch.pendingSource.value
  return source ? t('webSerials.preview.seriesLoading', { source }) : null
})
// The series database knows the publication status better than the scan site does.
const seriesStatus = computed(() => credits.match.value?.status ?? shown.value?.status ?? 'unknown')
const {
  libraries,
  folders,
  packaging,
  libraryId,
  folderId,
  submitting,
  error,
  selectedUnits,
  summary,
  nothingToDownload,
  canSubmit,
  choosesPackaging,
  isManga,
  rangeIncludesImportedGap,
  volumeLoading,
  volumeUnavailable,
  effectiveRange,
  volumeNotice,
  singleChapterCount,
} = form

onMounted(() => {
  void form.fetchLibraries()
})

// Only a series the details database knows can be asked for in print, and only when it says the series is licensed.
const publishedSeries = computed<PublishedSeries | null>(() => {
  const match = credits.match.value
  const detail = shown.value
  if (!match || !detail) return null
  return {
    kind: detail.kind,
    matchId: match.id,
    title: match.title,
    authors: credits.authors.value.length > 0 ? credits.authors.value : match.authors,
    url: match.url,
    publication: match.publication ?? null,
  }
})
const openedOption = computed(() => sourceOptions.value.find((option) => option.seriesKey === shown.value?.seriesKey) ?? null)
// Both mean the site carries the whole series while the match (and its print volumes) covers only its first arc.
const coversWholeSeries = computed(() => credits.match.value?.scope === 'part' || openedOption.value?.confidence === 'whole_series')
const publishedReason = computed(() => (publishedSeries.value?.publication?.licensed && !coversWholeSeries.value ? 'licensed' : null))
const headerTitle = computed(() => {
  const match = credits.match.value
  return coversWholeSeries.value && match ? baseSeriesDisplayTitle(match.title) : credits.canonicalTitle.value
})
const showSourceTitle = computed(() => {
  const detail = shown.value
  if (!detail || !credits.match.value) return false
  if (!coversWholeSeries.value) return credits.sourceTitleDiffers.value
  return baseSeriesTitle(detail.title) !== baseSeriesTitle(headerTitle.value)
})

const synopsis = computed(() => props.entry?.synopsis?.trim() || shown.value?.synopsis?.trim() || '')
const matchGenres = computed(() => credits.match.value?.genres ?? [])
const packagingOptions = computed(() => shown.value?.packagingOptions ?? [])
const selectedLibrary = computed(() => libraries.value.find((library) => library.id === libraryId.value) ?? null)
const importedCount = computed(() => shown.value?.importedUnitKeys.length ?? 0)
const newestPublishedAt = computed(() => {
  const timestamps = (shown.value?.units ?? [])
    .map((unit) => (unit.publishedAt ? new Date(unit.publishedAt).getTime() : Number.NaN))
    .filter(Number.isFinite)
  return timestamps.length > 0 ? Math.max(...timestamps) : null
})
const updatedLine = computed(() =>
  newestPublishedAt.value === null ? null : t('webSerials.preview.updated', { time: formatRelativeFromNow(newestPublishedAt.value) }),
)
const availableLine = computed(() => {
  const detail = shown.value
  if (!detail) return ''
  return t(`webSerials.preview.available.${detail.kind}`, { count: formatNumber(detail.units.length) })
})
const authorLine = computed(() => credits.authors.value.join(', '))
// Only the folder is certain: the rest of the path comes from the library's own naming pattern.
const savedPath = computed(() => {
  if (!shown.value || !selectedLibrary.value) return null
  return folders.value.find((folder) => folder.id === folderId.value)?.path ?? selectedLibrary.value.name
})
const getDisabled = computed(() => !canSubmit.value || switching.value || credits.loading.value)
const showUnknownAuthorHint = computed(() => credits.state.value !== 'loading' && credits.hasNoAuthor.value)
const footerSummary = computed(() => {
  const detail = shown.value
  if (!detail) return ''
  return t(`webSerials.preview.footer.${detail.kind}`, {
    units: selectedUnits.value.length,
    books: summary.value.toDownload,
    source: detail.sourceName,
  })
})

function packagingDisabled(option: WebSerialPackaging): boolean {
  return option === 'volume' && isManga.value && (volumeLoading.value || volumeUnavailable.value)
}

function packagingHint(option: WebSerialPackaging): string {
  if (option === 'volume' && isManga.value && volumeUnavailable.value) return t('webSerials.preview.volumeUnavailable')
  return t(`webSerials.preview.packaging.${isManga.value ? 'manga.' : ''}${option}.hint`)
}

function handleSelectSource(seriesKey: string) {
  const sourceName = sourceOptions.value.find((option) => option.seriesKey === seriesKey)?.sourceName ?? null
  return selectSource(seriesKey, () => credits.keepCreditsForNextSeries(), sourceName)
}

function handleOpenChange(value: boolean) {
  emit('update:open', value)
}

function handleClose() {
  emit('update:open', false)
}

function handleRetry() {
  if (suggestionError.value !== null) void entryPreview.retry()
  else emit('retry')
}

function handleRetryEntry() {
  void entryPreview.retry()
}

function handleRetryFailedSources() {
  void entryPreview.retryFailed()
}

function handleSearchSites() {
  if (props.entry) emit('search-sites', props.entry.title)
}

function handleAuthors(values: string[]) {
  credits.setAuthors(values)
}

function handleArtists(values: string[]) {
  credits.setArtists(values)
}

function handleRejectMatch() {
  credits.rejectMatch()
}

function handleRestoreMatch() {
  credits.restoreMatch()
}

function handleRetryLookup() {
  void credits.load()
}

function handleLibrary(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  form.selectLibrary(value === '' ? null : Number(value))
}

function handleFolder(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  form.setFolder(value === '' ? null : Number(value))
}

function handlePackaging(option: WebSerialPackaging) {
  form.setPackaging(option)
}

function handleMode(mode: 'all' | 'range') {
  form.setMode(mode)
}

function handleSelectUnit(sequence: string) {
  form.selectRangeUnit(sequence)
}

function handleSelectLatest() {
  form.selectLatest()
}

function handleSelectFirst() {
  form.selectFirst()
}

function handleSelectMissing() {
  form.selectNotImported()
}

function handleClearRange() {
  form.clearRange()
}

async function handleGet() {
  const job = await form.submit(credits.metadata())
  if (job) emit('created', job)
}
</script>

<template>
  <Sheet :open="props.open" @update:open="handleOpenChange">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-2xl">
      <SheetTitle class="sr-only">{{ shown ? t('webSerials.preview.titleFor', { title: shown.title }) : t('webSerials.preview.title') }}</SheetTitle>
      <SheetDescription class="sr-only">{{ t('webSerials.preview.description') }}</SheetDescription>

      <div v-if="showLoading" class="flex h-full flex-col" aria-busy="true" :aria-label="t('webSerials.preview.loading')">
        <p
          v-if="seriesLoadingNotice"
          role="status"
          class="flex items-start gap-2 px-5 pt-10 text-sm text-muted-foreground"
          data-testid="series-loading"
        >
          <Loader2 class="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
          {{ seriesLoadingNotice }}
        </p>
        <div class="flex animate-pulse gap-4 border-b border-border p-5 pt-10" aria-hidden="true">
          <div class="aspect-2/3 w-20 shrink-0 rounded-sm bg-muted" />
          <div class="flex-1 space-y-3 pt-1">
            <div class="h-5 w-3/4 rounded bg-muted" />
            <div class="h-3 w-2/5 rounded bg-muted" />
            <div class="h-5 w-1/3 rounded bg-muted" />
            <div class="h-3 w-1/2 rounded bg-muted" />
          </div>
        </div>
        <div class="flex-1 space-y-5 p-5" aria-hidden="true">
          <div class="space-y-2">
            <div class="h-3 w-full rounded bg-muted" />
            <div class="h-3 w-11/12 rounded bg-muted" />
            <div class="h-3 w-4/5 rounded bg-muted" />
          </div>
          <div>
            <div class="mb-3 h-3 w-1/4 rounded bg-muted" />
            <div v-for="index in 6" :key="index" class="h-10 border-b border-border py-3 last:border-b-0">
              <div class="h-3 rounded bg-muted" :class="index % 2 ? 'w-2/5' : 'w-1/3'" />
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="shownLoadError" class="flex h-full items-center p-5">
        <EmptyState icon="TriangleAlert" :title="t('webSerials.preview.loadErrorTitle')" :hint="shownLoadError" class="w-full">
          <template #actions>
            <Button @click="handleRetry">{{ t('common.retry') }}</Button>
            <Button variant="outline" @click="handleClose">{{ t('common.cancel') }}</Button>
          </template>
        </EmptyState>
      </div>

      <WebSerialEntryPreview
        v-else-if="entry && !shown"
        :entry="entry"
        :state="entryPreview.state.value"
        :options="entryPreview.options.value"
        :failed-sources="entryPreview.failedSources.value"
        :error="entryPreview.error.value"
        :selected-key="entryPreview.preselectedKey.value ?? ''"
        :loading-notice="seriesLoadingNotice"
        @close="handleClose"
        @retry="handleRetryEntry"
        @retry-failed="handleRetryFailedSources"
        @search-sites="handleSearchSites"
      />

      <div v-else-if="shown" class="flex h-full flex-col">
        <header class="shrink-0 border-b border-border p-5 pt-10">
          <div class="flex items-start gap-4">
            <WebSerialCover :src="coverSrc" :title="shown.title" class="aspect-2/3 w-20" />
            <div class="min-w-0 flex-1 pe-2">
              <h2 class="line-clamp-3 text-lg leading-snug font-bold text-foreground">{{ headerTitle }}</h2>
              <p v-if="showSourceTitle" class="mt-0.5 truncate text-xs text-muted-foreground">{{ shown.title }}</p>
              <p v-if="authorLine" class="mt-0.5 text-sm text-muted-foreground">{{ authorLine }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="inline-flex h-5.5 items-center rounded-full border border-border bg-muted px-2 text-xs font-medium text-foreground">
                  {{ t(`webSerials.preview.kind.${shown.kind}`) }}
                </span>
                <span
                  v-if="seriesStatus !== 'unknown'"
                  class="inline-flex h-5.5 items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2 text-xs font-medium text-info"
                >
                  <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                  {{ t(`webSerials.seriesStatus.${seriesStatus}`) }}
                </span>
                <span v-if="updatedLine" class="text-xs text-muted-foreground">{{ updatedLine }}</span>
              </div>
              <a
                v-if="shown.sourceUrl"
                :href="shown.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <Link2 :size="12" class="shrink-0" aria-hidden="true" />
                <span class="truncate">{{ shown.sourceName }}</span>
                <ExternalLink :size="11" class="shrink-0" aria-hidden="true" />
              </a>
              <p v-else class="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Link2 :size="12" aria-hidden="true" />
                {{ shown.sourceName }}
              </p>
              <span
                v-if="importedCount > 0"
                class="mt-1.5 inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-medium text-success"
              >
                <Check :size="12" :stroke-width="2.5" aria-hidden="true" />
                {{ t('webSerials.preview.alreadyInLibrary', { count: formatNumber(importedCount) }) }}
              </span>
            </div>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <WebSerialSynopsis v-if="synopsis" :synopsis="synopsis" />

          <WebSerialTags :genres="matchGenres" :tags="shown.tags" />

          <WebSerialCredits
            :state="credits.state.value"
            :match="credits.match.value"
            :message="credits.unavailableMessage.value"
            :authors="credits.authors.value"
            :artists="credits.artists.value"
            :show-artists="isManga"
            @update:authors="handleAuthors"
            @update:artists="handleArtists"
            @reject="handleRejectMatch"
            @restore="handleRestoreMatch"
            @retry="handleRetryLookup"
          />

          <WebSerialSources
            :key="sourcesRenderKey"
            :options="sourceOptions"
            :state="sourcesState"
            :selected-key="shown.seriesKey"
            :disabled="switching"
            :discover="fromDiscover"
            :entry-state="entryPreview.state.value"
            :failed-sources="entryPreview.failedSources.value"
            @select="handleSelectSource"
            @retry="handleRetryEntry"
            @retry-failed="handleRetryFailedSources"
            @search-sites="handleSearchSites"
          />
          <p
            v-if="switching && seriesLoadingNotice"
            role="status"
            class="flex items-start gap-2 text-xs text-muted-foreground"
            data-testid="series-loading"
          >
            <Loader2 class="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {{ seriesLoadingNotice }}
          </p>
          <p v-if="switchError" role="alert" class="flex items-start gap-2 text-xs text-destructive">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {{ switchError }}
          </p>

          <section class="space-y-2" :aria-labelledby="`web-serial-units-${shown.kind}`">
            <div class="flex items-center gap-2.5">
              <h3 :id="`web-serial-units-${shown.kind}`" class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {{ t(`webSerials.preview.units.${shown.kind}`) }}
              </h3>
              <span class="ms-auto text-xs text-muted-foreground tabular-nums">{{ availableLine }}</span>
            </div>
            <p v-if="shown.units.length === 0" class="text-sm text-muted-foreground">{{ t('webSerials.preview.noUnits') }}</p>
            <WebSerialUnitPicker
              v-else
              :kind="shown.kind"
              :units="shown.units"
              :imported-unit-keys="shown.importedUnitKeys"
              :imported-group-keys="shown.importedGroupKeys"
              :range="effectiveRange"
              :show-volumes="isManga && packaging === 'volume'"
              :volume-of="form.volumeOf"
              :range-includes-imported-gap="rangeIncludesImportedGap"
              @set-mode="handleMode"
              @select-unit="handleSelectUnit"
              @select-latest="handleSelectLatest"
              @select-first="handleSelectFirst"
              @select-missing="handleSelectMissing"
              @clear-range="handleClearRange"
            />
          </section>

          <WebSerialPublishedDisclosure
            v-if="publishedSeries && publishedReason"
            :key="publishedSeries.matchId"
            :series="publishedSeries"
            :reason="publishedReason"
          />

          <section class="space-y-2.5" aria-labelledby="web-serial-landing-title">
            <h3 id="web-serial-landing-title" class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {{ t('webSerials.preview.landing') }}
            </h3>

            <div
              v-if="choosesPackaging"
              role="radiogroup"
              :aria-label="t('webSerials.preview.landing')"
              class="grid gap-2"
              :class="isManga ? 'sm:grid-cols-3' : 'sm:grid-cols-2'"
            >
              <label
                v-for="option in packagingOptions"
                :key="option"
                class="flex items-start gap-3 rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring"
                :class="[
                  packagingDisabled(option) ? 'cursor-not-allowed bg-muted/50 opacity-70' : 'cursor-pointer',
                  packaging === option ? 'border-primary bg-primary/7 ring-1 ring-primary' : 'border-border bg-background',
                  !packagingDisabled(option) && packaging !== option ? 'hover:bg-muted' : '',
                ]"
                :aria-disabled="packagingDisabled(option)"
              >
                <input
                  type="radio"
                  name="web-serials-packaging"
                  class="mt-0.5 size-4 accent-primary"
                  :value="option"
                  :checked="packaging === option"
                  :disabled="packagingDisabled(option)"
                  @change="handlePackaging(option)"
                />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    {{ t(`webSerials.preview.packaging.${isManga ? 'manga.' : ''}${option}.label`) }}
                    <Loader2
                      v-if="option === 'volume' && isManga && volumeLoading"
                      class="size-3.5 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                  </span>
                  <span class="mt-0.5 block text-xs text-muted-foreground">{{ packagingHint(option) }}</span>
                </span>
              </label>
            </div>
            <WebSerialVolumeNotice v-if="volumeNotice" :notice="volumeNotice" :single-chapters="singleChapterCount" />

            <div class="grid grid-cols-1 gap-2.5">
              <div class="flex min-w-0 flex-col gap-1.5">
                <label for="web-serials-library" class="settings-label">{{ t('webSerials.preview.library') }}</label>
                <select id="web-serials-library" class="select-field w-full" :value="libraryId ?? ''" @change="handleLibrary">
                  <option value="" disabled>{{ t('webSerials.preview.libraryPlaceholder') }}</option>
                  <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                </select>
              </div>
              <div v-if="folders.length > 1" class="flex min-w-0 flex-col gap-1.5">
                <label for="web-serials-folder" class="settings-label">{{ t('webSerials.preview.folder') }}</label>
                <select id="web-serials-folder" class="select-field w-full" :value="folderId ?? ''" @change="handleFolder">
                  <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.path }}</option>
                </select>
              </div>
            </div>
            <p v-if="savedPath" class="truncate text-xs text-muted-foreground">
              {{ t('webSerials.preview.savedTo') }} <span class="font-mono text-foreground">{{ savedPath }}</span>
            </p>
            <p v-if="libraries.length === 0" class="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              {{ t('webSerials.preview.noLibraries') }}
            </p>
          </section>

          <p v-if="showUnknownAuthorHint" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TriangleAlert class="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            {{ t('webSerials.preview.unknownAuthorHint') }}
          </p>

          <p
            v-if="error"
            role="alert"
            class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {{ error }}
          </p>
        </div>

        <footer class="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm text-muted-foreground tabular-nums">
            {{ nothingToDownload ? t('webSerials.preview.summary.nothing') : footerSummary }}
          </p>
          <div class="flex items-center justify-end gap-2">
            <Button variant="outline" @click="handleClose">{{ t('webSerials.preview.cancel') }}</Button>
            <Button :disabled="getDisabled" @click="handleGet">
              <Loader2 v-if="submitting" class="animate-spin" aria-hidden="true" />
              <Download v-else aria-hidden="true" />
              {{ t('webSerials.preview.get') }}
            </Button>
          </div>
        </footer>
      </div>
    </SheetContent>
  </Sheet>
</template>
