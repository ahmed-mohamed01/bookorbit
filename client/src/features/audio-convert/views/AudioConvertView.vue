<script setup lang="ts">
// Fork: Tools › Convert to M4B. Structure follows BulkRenameView: a rail of books, a detail pane,
// a confirm dialog, and a run bar instead of a blocking run dialog.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AudioLines, Loader2, Play } from '@lucide/vue'
import type { AudioConvertEncoderOptions, AudioConvertJob, AudioConvertPreviewItem, Library } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { storage } from '@/services/storage'
import AudioConvertConfirmDialog from '../components/AudioConvertConfirmDialog.vue'
import AudioConvertDetail from '../components/AudioConvertDetail.vue'
import AudioConvertRail from '../components/AudioConvertRail.vue'
import AudioConvertRunBar from '../components/AudioConvertRunBar.vue'
import { useActiveKeydown } from '../composables/useActiveKeydown'
import { useAudioConvert, type AudioConvertScope } from '../composables/useAudioConvert'
import { useAudioConvertEnabled } from '../composables/useAudioConvertEnabled'
import { useAudioConvertReview } from '../composables/useAudioConvertReview'
import { useAudioConvertSettings } from '../composables/useAudioConvertSettings'

const LIBRARY_KEY = 'tools.audioConvert.libraryId'

const { t } = useI18n()
const { libraries, fetchLibraries } = useLibraries()
const { enabled, encoder } = useAudioConvertEnabled()
const convertSettings = useAudioConvertSettings()
const audio = useAudioConvert()

const showConfirm = ref(false)
const mobileDetail = ref(false)
const librariesReady = ref(false)
const railRef = ref<InstanceType<typeof AudioConvertRail> | null>(null)

const selectedLibrary = computed(() => libraries.value.find((library: Library) => library.id === audio.selectedLibraryId.value) ?? null)
const totalSelectable = computed(() => audio.totalByStatus.value.can_convert)
const review = useAudioConvertReview(audio.items, totalSelectable, audio.appliedSearch)

const currentPlan = computed(() => (review.current.value ? (audio.plans.value.get(review.current.value.bookId) ?? null) : null))
const currentPlanLoading = computed(() => review.current.value !== null && audio.planLoadingId.value === review.current.value.bookId)
const currentPlanFailed = computed(() => review.current.value !== null && audio.planErrorId.value === review.current.value.bookId)

/** The grid waits for both the first page and the first status, so the run bar never pushes it down later. */
const ready = computed(() => audio.previewReady.value && audio.statusReady.value)
const previewErrorMessage = computed(() => {
  const failure = audio.previewError.value
  return failure?.code === 'http' ? t('audioConvert.view.httpError', { status: failure.status ?? 0 }) : t('audioConvert.view.unknownError')
})

function handleKeydown(event: KeyboardEvent): void {
  const target = event.target
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return
  if (showConfirm.value || audio.selectedLibraryId.value === null) return
  if (event.key === 'ArrowDown' || event.key === 'j') {
    event.preventDefault()
    review.step(1)
  } else if (event.key === 'ArrowUp' || event.key === 'k') {
    event.preventDefault()
    review.step(-1)
  } else if ((event.key === 's' || event.key === 'S') && review.current.value) {
    event.preventDefault()
    review.toggleSelected(review.current.value)
  }
}

useActiveKeydown(handleKeydown)

onMounted(async () => {
  void convertSettings.load()
  await fetchLibraries()
  librariesReady.value = true
  const remembered = storage.get<number | null>(LIBRARY_KEY, null)
  const initial = libraries.value.find((library) => library.id === remembered) ?? (libraries.value.length === 1 ? libraries.value[0] : null)
  if (initial && audio.selectedLibraryId.value === null) handleSelectLibrary(initial.id)
})

watch(
  () => review.current.value?.bookId,
  (bookId) => {
    railRef.value?.revealCurrent()
    const item = review.current.value
    if (bookId !== undefined && item && item.status !== 'waiting') void audio.loadPlan(bookId)
  },
)

function handleSelectLibrary(libraryId: number): void {
  storage.set(LIBRARY_KEY, libraryId)
  audio.selectLibrary(libraryId)
  review.reset()
  mobileDetail.value = false
  void audio.loadPreview()
  void audio.refreshStatus()
}

/** Scope only filters the view; the selection lives on the Can convert totals and survives it. */
function handleScopeChange(scope: AudioConvertScope): void {
  review.selectedId.value = null
  audio.setScope(scope)
}

function handleSearchChange(value: string): void {
  audio.setSearch(value)
  review.selectedId.value = null
}

function handleSelect(bookId: number): void {
  review.select(bookId)
  mobileDetail.value = true
}

function handleBack(): void {
  mobileDetail.value = false
}

function handleStep(delta: number): void {
  review.step(delta)
}

function handleToggleSelectedCurrent(): void {
  if (review.current.value) review.toggleSelected(review.current.value)
}

function handleToggleSelected(item: AudioConvertPreviewItem): void {
  review.toggleSelected(item)
}

function handleToggleGroup(key: string): void {
  review.toggleGroup(key)
}

function handleToggleGroupSelected(key: string): void {
  review.toggleGroupSelected(key)
}

function handleToggleAll(): void {
  review.toggleAll()
}

function handleLoadMore(): void {
  void audio.loadMore()
}

function handleRetryPlan(): void {
  if (review.current.value) void audio.loadPlan(review.current.value.bookId, true)
}

function handleRetryPreview(): void {
  void audio.loadPreview()
}

function handleOpenConfirm(): void {
  showConfirm.value = true
}

function handleCancelConfirm(): void {
  showConfirm.value = false
}

async function handleConfirmRun(options: Partial<AudioConvertEncoderOptions>): Promise<void> {
  const result = await audio.run(review.runSelection.value, options)
  showConfirm.value = false
  if (!result) {
    toast.error(t('audioConvert.toast.runFailed'))
    return
  }
  review.resetAfterRun()
  if (result.skipped > 0) toast.success(t('audioConvert.toast.queuedSkipped', { count: result.queued, skipped: result.skipped }))
  else toast.success(t('audioConvert.toast.queued', { count: result.queued }))
}

async function handleStop(): Promise<void> {
  const cancelled = await audio.stop()
  if (cancelled === null) toast.error(t('audioConvert.toast.stopFailed'))
  else toast.success(t('audioConvert.toast.stopped', { count: cancelled }))
}

function handleDismiss(): void {
  audio.dismissFinished()
}

async function handleSkip(job: AudioConvertJob): Promise<void> {
  if (!(await audio.skipJob(job))) toast.error(t('audioConvert.toast.actionFailed'))
}

async function handleConvertNow(job: AudioConvertJob): Promise<void> {
  if (!(await audio.convertJobNow(job))) toast.error(t('audioConvert.toast.actionFailed'))
}
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col">
    <div v-if="enabled === false" class="flex flex-1 flex-col items-center justify-start gap-3 px-10 pt-12 pb-10 text-center">
      <span class="grid size-14 place-items-center rounded-md bg-muted text-muted-foreground">
        <AudioLines class="size-6" aria-hidden="true" />
      </span>
      <p class="text-base font-semibold">{{ t('audioConvert.view.disabledTitle') }}</p>
      <p class="max-w-sm text-sm text-muted-foreground">{{ t('audioConvert.view.disabledDescription') }}</p>
    </div>

    <div v-else-if="!librariesReady || enabled === null" class="flex flex-1 items-center justify-center">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <div
      v-else-if="audio.selectedLibraryId.value === null"
      class="flex flex-1 flex-col items-center justify-start gap-4 px-10 pt-12 pb-10 text-center"
    >
      <span class="grid size-14 place-items-center rounded-md bg-muted text-muted-foreground">
        <AudioLines class="size-6" aria-hidden="true" />
      </span>
      <div class="space-y-1">
        <p class="text-base font-semibold">{{ t('audioConvert.view.emptyTitle') }}</p>
        <p class="max-w-sm text-sm text-muted-foreground">{{ t('audioConvert.view.emptyDescription') }}</p>
      </div>
      <div class="flex flex-wrap justify-center gap-2">
        <Button v-for="library in libraries" :key="library.id" variant="outline" @click="handleSelectLibrary(library.id)">
          {{ library.name }}
        </Button>
      </div>
    </div>

    <div
      v-else-if="audio.previewError.value && audio.items.value.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
    >
      <p class="text-sm font-medium text-destructive">{{ t('audioConvert.view.previewFailed') }}</p>
      <p class="max-w-sm text-sm text-muted-foreground">{{ previewErrorMessage }}</p>
      <Button variant="outline" @click="handleRetryPreview">{{ t('common.retry') }}</Button>
    </div>

    <div v-else-if="!ready" class="flex flex-1 items-center justify-center">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <template v-else>
      <AudioConvertRunBar
        v-if="audio.runJobs.value.length > 0"
        :jobs="audio.runJobs.value"
        :stopping="audio.stopping.value"
        :backup-days="convertSettings.backupDays.value"
        @stop="handleStop"
        @dismiss="handleDismiss"
      />

      <div class="grid min-h-0 flex-1 md:grid-cols-[22rem_minmax(0,1fr)]">
        <AudioConvertRail
          ref="railRef"
          :class="{ 'max-md:hidden': mobileDetail }"
          :libraries="libraries"
          :library="selectedLibrary"
          :scope="audio.scope.value"
          :counts="audio.totalByStatus.value"
          :search="audio.search.value"
          :groups="review.groups.value"
          :collapsed="review.collapsed.value"
          :current-id="review.current.value?.bookId ?? null"
          :selected-count="review.selectedCount.value"
          :selection-state="review.selectionState.value"
          :has-more="audio.hasMore.value"
          :loading-more="audio.loadingMore.value"
          :loading="audio.loading.value"
          :is-selected="review.isSelected"
          :group-state="review.groupState"
          @select-library="handleSelectLibrary"
          @update:scope="handleScopeChange"
          @update:search="handleSearchChange"
          @select="handleSelect"
          @toggle-selected="handleToggleSelected"
          @toggle-group-selected="handleToggleGroupSelected"
          @toggle-group="handleToggleGroup"
          @toggle-all="handleToggleAll"
          @load-more="handleLoadMore"
        />

        <AudioConvertDetail
          :class="{ 'max-md:hidden': !mobileDetail }"
          :item="review.current.value"
          :plan="currentPlan"
          :plan-loading="currentPlanLoading"
          :plan-failed="currentPlanFailed"
          :index="review.currentIndex.value"
          :total="review.visible.value.length"
          :selected="review.current.value ? review.isSelected(review.current.value) : false"
          :selected-count="review.selectedCount.value"
          :backup-days="convertSettings.backupDays.value"
          :acting-job-id="audio.actingJobId.value"
          @step="handleStep"
          @toggle-selected="handleToggleSelectedCurrent"
          @convert="handleOpenConfirm"
          @skip="handleSkip"
          @convert-now="handleConvertNow"
          @retry-plan="handleRetryPlan"
          @back="handleBack"
        />
      </div>

      <div
        v-if="!mobileDetail && audio.scope.value === 'can_convert' && review.selectedCount.value > 0"
        class="flex-none border-t border-border bg-card/80 px-4 py-2.5 backdrop-blur-sm md:hidden"
      >
        <Button class="w-full" @click="handleOpenConfirm">
          <Play class="size-3.5" aria-hidden="true" />
          {{ t('audioConvert.detail.convert', { count: review.selectedCount.value }) }}
        </Button>
      </div>
    </template>

    <AudioConvertConfirmDialog
      :open="showConfirm"
      :count="review.selectedCount.value"
      :defaults="encoder"
      :backup-days="convertSettings.backupDays.value"
      :busy="audio.running.value"
      @confirm="handleConfirmRun"
      @cancel="handleCancelConfirm"
    />
  </div>
</template>
