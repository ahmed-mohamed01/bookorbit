<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Download, ExternalLink, Loader2, TriangleAlert } from '@lucide/vue'
import type { WebSerialCatalogEntry, WebSerialSourceOption } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import type { WebSerialEntryPreviewState } from '../composables/useWebSerialEntryPreview'
import type { PublishedSeries } from '../lib/publishedVolumes'
import LnAcquisitionSection from './preview/LnAcquisitionSection.vue'
import WebSerialWebSourcesDisclosure from './preview/WebSerialWebSourcesDisclosure.vue'
import WebSerialCover from './WebSerialCover.vue'
import WebSerialPublishedVolumes from './preview/WebSerialPublishedVolumes.vue'
import WebSerialSources from './preview/WebSerialSources.vue'
import WebSerialSynopsis from './preview/WebSerialSynopsis.vue'
import WebSerialTags from './preview/WebSerialTags.vue'

const props = defineProps<{
  open: boolean
  webSourcesOpen?: boolean
  printVisible?: boolean
  entry: WebSerialCatalogEntry
  state: WebSerialEntryPreviewState
  options: WebSerialSourceOption[]
  failedSources: string[]
  error: string | null
  selectedKey: string
  /** Shown while the server is still loading the chosen source's long chapter list. */
  loadingNotice?: string | null
}>()

const emit = defineEmits<{ 'update:webSourcesOpen': [value: boolean]; close: []; retry: []; 'retry-failed': []; 'search-sites': [] }>()

const { t } = useI18n()

const authorLine = computed(() => props.entry.authors.join(', '))
const footerText = computed(() => {
  if (props.printVisible && !props.webSourcesOpen) return ''
  if (props.state === 'none') return t('webSerials.preview.entry.footerNone')
  if (props.state === 'error') return ''
  return t('webSerials.preview.entry.footerFinding')
})
const showOpenError = computed(() => props.state === 'error' && props.options.length > 0)
const publishedSeries = computed<PublishedSeries>(() => ({
  kind: props.entry.kind,
  matchId: props.entry.matchId,
  title: props.entry.title,
  authors: props.entry.authors,
  altTitles: props.entry.altTitles ?? [],
  url: props.entry.url,
  publication: props.entry.publication ?? null,
}))
// A source may still turn up while the check runs, so the print panel is only the main offer once none carries the series.
const publishedReason = computed(() => (props.state === 'none' ? 'unavailable' : null))

function handleWebSourcesOpen(value: boolean) {
  emit('update:webSourcesOpen', value)
}

function handleClose() {
  emit('close')
}

function handleRetry() {
  emit('retry')
}

function handleRetryFailed() {
  emit('retry-failed')
}

function handleSearchSites() {
  emit('search-sites')
}

function handleNoSelect() {
  // The sources cannot be switched before the first one has opened.
}
</script>

<template>
  <div class="flex h-full flex-col" data-testid="entry-preview">
    <header class="shrink-0 border-b border-border p-5 pt-10">
      <div class="flex items-start gap-4">
        <WebSerialCover :src="entry.coverUrl" :title="entry.title" class="aspect-2/3 w-20" />
        <div class="min-w-0 flex-1 pe-2">
          <h2 class="line-clamp-3 text-lg leading-snug font-bold text-foreground">{{ entry.title }}</h2>
          <p v-if="authorLine" class="mt-0.5 text-sm text-muted-foreground">{{ authorLine }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span class="inline-flex h-5.5 items-center rounded-full border border-border bg-muted px-2 text-xs font-medium text-foreground">
              {{
                t(
                  entry.kind === 'novel' && entry.publication?.licensed
                    ? 'webSerials.preview.kind.lightNovel'
                    : `webSerials.preview.kind.${entry.kind}`,
                )
              }}
            </span>
            <span
              v-if="entry.status !== 'unknown'"
              class="inline-flex h-5.5 items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2 text-xs font-medium text-info"
            >
              <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {{ t(`webSerials.seriesStatus.${entry.status}`) }}
            </span>
            <span v-if="entry.year !== null" class="text-xs text-muted-foreground">{{ entry.year }}</span>
          </div>
          <a
            :href="entry.url"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span class="truncate">MangaBaka</span>
            <ExternalLink :size="11" class="shrink-0" aria-hidden="true" />
          </a>
          <span
            v-if="entry.inLibrary"
            class="mt-1.5 flex w-fit items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-medium text-success"
          >
            <Check :size="12" :stroke-width="2.5" aria-hidden="true" />
            {{ t('webSerials.discover.series.inLibraryLabel') }}
          </span>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
      <WebSerialSynopsis v-if="entry.synopsis" :synopsis="entry.synopsis" />
      <WebSerialTags :genres="entry.genres" :tags="[]" />
      <LnAcquisitionSection v-if="printVisible" :series="publishedSeries" :open="open" />
      <WebSerialWebSourcesDisclosure :active="!!printVisible" :open="!!webSourcesOpen" @update:open="handleWebSourcesOpen">
        <WebSerialSources
          discover
          :options="options"
          state="ready"
          :entry-state="state"
          :failed-sources="failedSources"
          :error-message="error"
          :selected-key="selectedKey"
          :disabled="true"
          @select="handleNoSelect"
          @retry="handleRetry"
          @retry-failed="handleRetryFailed"
          @search-sites="handleSearchSites"
        />
        <p
          v-if="state === 'opening' && loadingNotice"
          role="status"
          class="flex items-start gap-2 text-xs text-muted-foreground"
          data-testid="series-loading"
        >
          <Loader2 class="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          {{ loadingNotice }}
        </p>
        <div v-if="showOpenError" role="alert" class="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ error }}</span>
          <Button size="sm" variant="outline" @click="handleRetry">{{ t('common.retry') }}</Button>
        </div>
      </WebSerialWebSourcesDisclosure>
      <WebSerialPublishedVolumes v-if="!printVisible" :series="publishedSeries" :reason="publishedReason" />
    </div>

    <footer
      v-if="!printVisible"
      class="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p class="text-sm text-muted-foreground">{{ footerText }}</p>
      <div class="flex items-center justify-end gap-2">
        <Button variant="outline" @click="handleClose">{{ t('webSerials.preview.cancel') }}</Button>
        <Button disabled>
          <Download aria-hidden="true" />
          {{ t('webSerials.preview.get') }}
        </Button>
      </div>
    </footer>
  </div>
</template>
