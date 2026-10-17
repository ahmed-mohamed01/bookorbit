<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Globe, Info } from '@lucide/vue'
import { Permission } from '@bookorbit/types'
import type {
  MoveWebSerialJobResult,
  WebSerialCatalogEntry,
  WebSerialJob,
  WebSerialJobScope,
  WebSerialSeriesDetail,
  WebSerialSuggestion,
} from '@bookorbit/types'
import { useAuth } from '@/features/auth/composables/useAuth'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { formatCompactNumber, formatNumber } from '@/i18n/formatters'
import WebSerialPreviewSheet from './components/WebSerialPreviewSheet.vue'
import WebSerialMoveSheet from './components/WebSerialMoveSheet.vue'
import WebSerialNovelProvidersSheet from './components/WebSerialNovelProvidersSheet.vue'
import WebSerialQueue from './components/WebSerialQueue.vue'
import WebSerialsSearchPanel from './components/WebSerialsSearchPanel.vue'
import { useWebSerialQueue } from './composables/useWebSerialQueue'
import { useWebSerialSeriesUrl } from './composables/useWebSerialSeriesUrl'
import { messageOf } from './lib/messageOf'
import { entryFromSuggestion } from './lib/serialSuggest'
import type { SerialJobAction } from './lib/serialJobStatus'

type WebSerialsTab = 'discover' | 'queue'

const TABS: WebSerialsTab[] = ['discover', 'queue']

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const { hasPermission } = usePermissions()
const { user } = useAuth()
const userId = computed(() => user.value?.id ?? null)
const canSetUp = computed(() => hasPermission(Permission.ManageAppSettings))
const activeTab = computed<WebSerialsTab>(() => (route.name === 'web-serials-queue' || route.query.tab === 'queue' ? 'queue' : 'discover'))
const queue = useWebSerialQueue(computed(() => activeTab.value === 'queue'))
const {
  jobs,
  activeCount,
  queuePaused,
  scope,
  loading,
  loaded,
  error,
  busyIds,
  queueBusy,
  clearing,
  expandedIds,
  details,
  hasMore,
  loadingMore,
  finishedCount,
} = queue

const searchPanel = ref<{ retryPreview: () => void; searchSitesFor: (title: string) => void; cancelPreview: () => void } | null>(null)
const previewDetail = ref<WebSerialSeriesDetail | null>(null)
const previewEntry = ref<WebSerialCatalogEntry | null>(null)
const previewSuggestion = ref<WebSerialSuggestion | null>(null)
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewLoadError = ref<string | null>(null)
const previewPending = ref<{ source: string | null } | null>(null)
const previewLoadingNotice = computed(() => {
  if (!previewLoading.value || !previewPending.value) return null
  const { source } = previewPending.value
  return source ? t('webSerials.preview.seriesLoading', { source }) : t('webSerials.preview.seriesLoadingLink')
})
const moveJob = ref<WebSerialJob | null>(null)
const moveOpen = ref(false)
const novelAvailable = ref(false)
const providersOpen = ref(false)

onMounted(() => {
  if (hasPermission(Permission.WebSerialAccess)) queue.start()
})

function tabCount(tab: WebSerialsTab): number | null {
  return tab === 'queue' && activeCount.value > 0 ? activeCount.value : null
}

// Both tabs stay on one route (a query switches them) so the page, its search results and open rows are not remounted.
function selectTab(tab: WebSerialsTab) {
  if (tab === activeTab.value) return
  const query = { ...route.query }
  delete query.tab
  if (tab === 'queue') query.tab = 'queue'
  void router.replace({ name: 'web-serials', query })
}

function handleNovelAvailable(value: boolean) {
  novelAvailable.value = value
}

function handleOpenProviders() {
  providersOpen.value = true
}

function handleProvidersOpenChange(value: boolean) {
  providersOpen.value = value
}

function handleSelectTab(tab: WebSerialsTab) {
  selectTab(tab)
}

const TAB_KEYS: Record<string, (index: number) => number> = {
  ArrowRight: (index) => (index + 1) % TABS.length,
  ArrowLeft: (index) => (index - 1 + TABS.length) % TABS.length,
  Home: () => 0,
  End: () => TABS.length - 1,
}

// The inactive tab is out of the tab order, so the arrow keys are how a keyboard reaches it.
function handleTabKeydown(event: KeyboardEvent) {
  const move = TAB_KEYS[event.key]
  if (!move) return
  event.preventDefault()
  const next = TABS[move(TABS.indexOf(activeTab.value))]!
  selectTab(next)
  document.getElementById(`web-serials-tab-${next}`)?.focus()
}

function handleOpenEntry(entry: WebSerialCatalogEntry) {
  previewDetail.value = null
  previewSuggestion.value = null
  previewEntry.value = entry
  previewLoading.value = false
  previewLoadError.value = null
  previewOpen.value = true
}

useWebSerialSeriesUrl(handleOpenEntry, (cause) => toast.error(messageOf(cause, 'webSerials.api.search')))

function handleOpenSuggestion(suggestion: WebSerialSuggestion) {
  previewDetail.value = null
  previewSuggestion.value = suggestion
  previewEntry.value = suggestion.matchId ? entryFromSuggestion({ ...suggestion, matchId: suggestion.matchId }) : null
  previewLoading.value = false
  previewLoadError.value = null
  previewOpen.value = true
}

function handleSearchSites(title: string) {
  previewOpen.value = false
  searchPanel.value?.searchSitesFor(title)
}

// The panel answers a preview it started; once the sheet closed or shows something else, that answer is stale.
function handleOpenDetail(detail: WebSerialSeriesDetail) {
  previewPending.value = null
  if (!previewLoading.value) return
  previewEntry.value = null
  previewSuggestion.value = null
  previewDetail.value = detail
  previewLoading.value = false
  previewLoadError.value = null
}

function handlePreviewLoading() {
  previewEntry.value = null
  previewSuggestion.value = null
  previewDetail.value = null
  previewLoading.value = true
  previewLoadError.value = null
  previewPending.value = null
  previewOpen.value = true
}

function handlePreviewPending(source: string | null) {
  if (previewLoading.value) previewPending.value = { source }
}

function handlePreviewError(message: string) {
  previewPending.value = null
  if (!previewLoading.value) return
  previewLoading.value = false
  previewLoadError.value = message
}

function handlePreviewRetry() {
  previewLoading.value = true
  previewLoadError.value = null
  searchPanel.value?.retryPreview()
}

function handlePreviewOpenChange(value: boolean) {
  previewOpen.value = value
  if (value) return
  if (previewLoading.value) searchPanel.value?.cancelPreview()
  previewLoading.value = false
  previewPending.value = null
}

async function handleCreated(job: WebSerialJob) {
  previewOpen.value = false
  toast.success(t('webSerials.toast.started', { title: job.title }))
  selectTab('queue')
  await queue.refresh()
}

function handleAction(type: SerialJobAction, id: number) {
  if (type === 'move') {
    moveJob.value = jobs.value.find((job) => job.id === id) ?? null
    moveOpen.value = moveJob.value !== null
    return
  }
  void queue.act(type, id)
}

function handleMoveOpenChange(value: boolean) {
  moveOpen.value = value
}

async function handleMoved(result: MoveWebSerialJobResult) {
  moveOpen.value = false
  toast.success(t('webSerials.queue.move.done', { source: result.to.sourceName }))
  await queue.refresh()
}

function handleToggle(id: number) {
  void queue.toggleExpanded(id)
}

function handleRetryItem(jobId: number, itemId: number) {
  void queue.retryItem(jobId, itemId)
}

function handleScope(next: WebSerialJobScope) {
  void queue.setScope(next)
}

async function handleClearFinished() {
  const removed = await queue.clearFinished()
  if (removed !== null) toast.success(t('webSerials.queue.cleared', { count: removed }))
}

function handleTogglePause() {
  void queue.setQueuePaused(!queuePaused.value)
}

function handleDiscover() {
  selectTab('discover')
}

function handleLoadMore() {
  void queue.loadMore()
}

function handleReload() {
  void queue.refresh()
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-420 flex-col py-4">
    <header class="mb-4">
      <div class="flex items-center gap-2.5">
        <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10">
          <Globe class="size-4.5 text-primary" aria-hidden="true" />
        </div>
        <h1 class="text-xl font-semibold tracking-tight text-foreground">{{ t('webSerials.title') }}</h1>
      </div>
      <p class="mt-1.5 flex items-start gap-1.5 text-sm text-muted-foreground">
        <span>{{ t('webSerials.subtitle') }}</span>
        <button
          v-if="novelAvailable"
          type="button"
          class="mt-0.5 shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-label="t('webSerials.novelProviders.open')"
          @click="handleOpenProviders"
        >
          <Info class="size-4" aria-hidden="true" />
        </button>
      </p>
    </header>

    <div role="tablist" :aria-label="t('webSerials.title')" class="mb-4 flex gap-1 border-b border-border" @keydown="handleTabKeydown">
      <button
        v-for="tab in TABS"
        :id="`web-serials-tab-${tab}`"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab"
        :aria-controls="activeTab === tab ? `web-serials-panel-${tab}` : undefined"
        :tabindex="activeTab === tab ? 0 : -1"
        class="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        :class="activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="handleSelectTab(tab)"
      >
        {{ t(`webSerials.tabs.${tab}`) }}
        <template v-if="tabCount(tab) !== null">
          <span
            class="ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary tabular-nums"
            aria-hidden="true"
          >
            {{ formatCompactNumber(tabCount(tab) ?? 0) }}
          </span>
          <span class="sr-only">{{ formatNumber(tabCount(tab) ?? 0) }}</span>
        </template>
      </button>
    </div>

    <section
      v-show="activeTab === 'discover'"
      id="web-serials-panel-discover"
      role="tabpanel"
      aria-labelledby="web-serials-tab-discover"
      class="w-full max-w-5xl"
    >
      <WebSerialsSearchPanel
        ref="searchPanel"
        :user-id="userId"
        :can-set-up="canSetUp"
        @novel-available="handleNovelAvailable"
        @open="handleOpenDetail"
        @open-entry="handleOpenEntry"
        @open-suggestion="handleOpenSuggestion"
        @preview-loading="handlePreviewLoading"
        @preview-error="handlePreviewError"
        @preview-pending="handlePreviewPending"
      />
    </section>

    <section
      v-if="activeTab === 'queue'"
      id="web-serials-panel-queue"
      role="tabpanel"
      aria-labelledby="web-serials-tab-queue"
      class="w-full max-w-5xl"
    >
      <WebSerialQueue
        :jobs="jobs"
        :loading="loading"
        :loaded="loaded"
        :error="error"
        :busy-ids="busyIds"
        :scope="scope"
        :queue-paused="queuePaused"
        :clearing="clearing"
        :queue-busy="queueBusy"
        :expanded-ids="expandedIds"
        :details="details"
        :has-more="hasMore"
        :finished-count="finishedCount"
        :loading-more="loadingMore"
        :user-id="userId"
        @action="handleAction"
        @toggle="handleToggle"
        @retry-item="handleRetryItem"
        @update:scope="handleScope"
        @clear-finished="handleClearFinished"
        @toggle-pause="handleTogglePause"
        @discover="handleDiscover"
        @reload="handleReload"
        @load-more="handleLoadMore"
      />
    </section>

    <WebSerialNovelProvidersSheet v-if="novelAvailable" :open="providersOpen" @update:open="handleProvidersOpenChange" />

    <WebSerialMoveSheet :job="moveJob" :open="moveOpen" @update:open="handleMoveOpenChange" @moved="handleMoved" />

    <WebSerialPreviewSheet
      :detail="previewDetail"
      :entry="previewEntry"
      :suggestion="previewSuggestion"
      :open="previewOpen"
      :loading="previewLoading"
      :load-error="previewLoadError"
      :loading-notice="previewLoadingNotice"
      @update:open="handlePreviewOpenChange"
      @created="handleCreated"
      @retry="handlePreviewRetry"
      @search-sites="handleSearchSites"
    />
  </div>
</template>
