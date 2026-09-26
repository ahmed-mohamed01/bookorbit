<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, BookAudio, Info, Loader2, Lock, RefreshCw, Sparkles } from '@lucide/vue'
import type { EditionLinkMember, ReadAlongBlockReason, StorytellerExistingMatch } from '@bookorbit/types'
import { readAlongKeepCopyHint } from '@/features/book/lib/read-along-copy-hint'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import type { ReadAlongRowState } from '@/features/book/composables/useReadAlong'

// Keyed by the union rather than hand-listed, so a reason added to the contract fails to compile
// here instead of falling through to null and rendering a blocked build as silence.
const BLOCK_MESSAGE_KEYS: Record<ReadAlongBlockReason, string> = {
  not_configured: 'book.detail.editionLink.readAlong.blocked.notConfigured',
  unreachable: 'book.detail.editionLink.readAlong.blocked.unreachable',
  busy: 'book.detail.editionLink.readAlong.blocked.busy',
  no_pair: 'book.detail.editionLink.readAlong.blocked.noPair',
  no_epub: 'book.detail.editionLink.readAlong.blocked.noEpub',
  source_epub_unreadable: 'book.detail.editionLink.readAlong.blocked.sourceEpubUnreadable',
  no_audio: 'book.detail.editionLink.readAlong.blocked.noAudio',
  no_target_library: 'book.detail.editionLink.readAlong.blocked.noTargetLibrary',
  target_not_allowed: 'book.detail.editionLink.readAlong.blocked.targetNotAllowed',
  format_not_allowed: 'book.detail.editionLink.readAlong.blocked.formatNotAllowed',
  previous_output_not_deletable: 'book.detail.editionLink.readAlong.blocked.previousOutputNotDeletable',
}

const props = defineProps<{
  state: ReadAlongRowState
  member: EditionLinkMember | null
  canGenerate: boolean
  /** Replacing an output means deleting it, which the build endpoint holds to LibraryDeleteBooks. */
  canRebuild: boolean
  existingMatch: StorytellerExistingMatch | null
  isCurrentBook: boolean
}>()

const emit = defineEmits<{
  'update:keepRemoteCopy': [value: boolean]
  generate: []
  importExisting: [uuid: string]
  retry: []
  rebuild: []
}>()

const { t } = useI18n()
const keepCopyLabelId = `read-along-keep-copy-${useId()}`

const rowState = computed<'ready' | 'outOfReach' | 'building' | 'failed' | 'none'>(() => {
  if (props.state.status === 'building') return 'building'
  if (props.state.status === 'failed') return 'failed'
  if (props.state.status !== 'ready') return 'none'
  // A ready build the server described without its book is one that landed in a library this user
  // cannot open: the read-along exists, so nothing here may offer to build it again. The server
  // reports a ready build whose output was deleted as 'none' instead, which stays generatable.
  return props.member !== null || props.state.hasOutputBook ? 'ready' : 'outOfReach'
})

const rowIcon = computed(() => {
  if (rowState.value === 'building') return Loader2
  if (rowState.value === 'failed') return AlertTriangle
  if (rowState.value === 'outOfReach') return Lock
  return BookAudio
})

const rowIconClass = computed(() => {
  if (rowState.value === 'building') return 'animate-spin text-sky-500'
  if (rowState.value === 'failed') return 'text-destructive'
  if (rowState.value === 'ready') return 'text-primary'
  return 'text-muted-foreground'
})

const memberTitle = computed(() => props.member?.title ?? t('book.detail.editionLink.unknownTitle'))

const memberRoute = computed(() => ({ name: 'book-detail', params: { bookId: props.member?.id } }))

const textProgressLabel = computed(() => {
  const percentage = props.member?.progress?.percentage
  if (typeof percentage !== 'number') return null
  return t('book.detail.editionLink.readAlong.progressRead', { percentage: Math.round(percentage) })
})

const narrationProgressLabel = computed(() => {
  const percentage = props.member?.narrationPercentage
  if (typeof percentage !== 'number') return null
  return t('book.detail.editionLink.readAlong.progressListened', { percentage: Math.round(percentage) })
})

const phaseLabel = computed(() => {
  switch (props.state.phase) {
    case 'prepare':
      return t('book.detail.editionLink.readAlong.phase.prepare')
    case 'register':
      return t('book.detail.editionLink.readAlong.phase.register')
    case 'process':
      return t('book.detail.editionLink.readAlong.phase.process')
    case 'wait':
      return t('book.detail.editionLink.readAlong.phase.wait')
    case 'collect':
      return t('book.detail.editionLink.readAlong.phase.collect')
    default:
      return t('book.detail.editionLink.readAlong.building')
  }
})

// How the pair reached Storyteller, which is what decides whether a multi-GB audiobook is being
// uploaded or read where it already sits. Only known while a build is on screen.
const transportLabel = computed(() => {
  switch (props.state.transport) {
    case 'shared-paths':
      return t('book.detail.editionLink.readAlong.transport.sharedPaths')
    case 'api-transfer':
      return t('book.detail.editionLink.readAlong.transport.apiTransfer')
    default:
      return null
  }
})

// Storyteller's three alignment stages, in the order it runs them and worded as its own UI words
// them. The order matters for the "stage N of 3" line: Storyteller reports progress per stage and
// restarts it at every boundary, so without the stage number a transition reads as progress going backwards.
const REMOTE_TASKS = [
  { id: 'SPLIT_TRACKS', key: 'book.detail.editionLink.readAlong.remoteTasks.splitTracks' },
  { id: 'TRANSCRIBE_CHAPTERS', key: 'book.detail.editionLink.readAlong.remoteTasks.transcribeChapters' },
  { id: 'SYNC_CHAPTERS', key: 'book.detail.editionLink.readAlong.remoteTasks.syncChapters' },
] as const

/** A stage Storyteller adds later still reads as words rather than as a constant. */
function humanizeTask(task: string): string {
  const words = task.replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const remoteTask = computed(() => {
  const task = props.state.remoteTask
  if (!task) return null
  const upper = task.toUpperCase()
  const index = REMOTE_TASKS.findIndex((entry) => entry.id === upper)
  const known = REMOTE_TASKS[index]
  if (!known) return { label: humanizeTask(task), step: null }
  return { label: t(known.key), step: index + 1 }
})

// Storyteller's stage only describes what Storyteller is doing. Once BookOrbit has taken over to
// collect and import the file, leaving the last stage on screen at 100% reads as if alignment were
// still running - or, worse, as if a finished job were stuck.
const remoteStageActive = computed(() => props.state.phase === 'process' || props.state.phase === 'wait')

const stageLabel = computed(() => {
  if (!remoteStageActive.value) return null
  const task = remoteTask.value
  if (!task) return null
  if (task.step === null) return task.label
  return t('book.detail.editionLink.readAlong.remoteTasks.step', { step: task.step, total: REMOTE_TASKS.length, label: task.label })
})

const keepCopyHint = computed(() => readAlongKeepCopyHint(props.state.remoteCopyBytes, props.state.transport !== null, t))

function handleKeepRemoteCopy(value: boolean) {
  emit('update:keepRemoteCopy', value)
}

// Background detail rather than status, so it lives behind the row's one info affordance instead of
// adding lines to a card that is mostly a progress bar.
const destinationHint = computed(() => {
  const destination = props.state.targetLibraryName
    ? t('book.detail.editionLink.readAlong.destinationHint', { library: props.state.targetLibraryName })
    : t('book.detail.editionLink.readAlong.destinationHintUnknown')
  return transportLabel.value ? `${destination} ${transportLabel.value}` : destination
})

// Where the file will land matters most before the build is started, which is exactly the case the
// server computes targetLibraryName for.
const showDestinationHint = computed(() => rowState.value === 'building' || (rowState.value === 'none' && props.canGenerate))

const remotePercentage = computed(() => {
  if (!remoteStageActive.value) return null
  const progress = props.state.remoteProgress
  if (typeof progress !== 'number' || Number.isNaN(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress * 100)))
})

const blockMessage = computed(() => (props.state.blocked ? t(BLOCK_MESSAGE_KEYS[props.state.blocked]) : null))

// 'busy' clears on its own once Storyteller frees a slot, so the action stays clickable for a retry.
// Every other reason needs a change elsewhere (settings, a permission, a missing file) first, so the
// action is disabled instead of being left to be rejected again with nothing to show for it.
const blockedFromRetrying = computed(() => props.state.blocked !== null && props.state.blocked !== 'busy')

const actionDisabled = computed(() => props.state.mutating || blockedFromRetrying.value)

// Only an aligned Storyteller book can be imported: an unaligned one still has to be processed.
const importMatch = computed(() => (props.existingMatch?.aligned ? props.existingMatch : null))

const failureMessage = computed(() => props.state.error ?? t('book.detail.editionLink.readAlong.failedFallback'))

function handleGenerate() {
  emit('generate')
}

function handleImportExisting() {
  if (importMatch.value) emit('importExisting', importMatch.value.uuid)
}

function handleRetry() {
  emit('retry')
}

// A rebuild deletes the book it replaces, and nothing else in this feature removes a book from the
// library, so it is the one action here that asks first.
const confirmingRebuild = ref(false)

function handleRebuild() {
  confirmingRebuild.value = true
}

function handleRebuildConfirmed() {
  confirmingRebuild.value = false
  emit('rebuild')
}

function handleRebuildCancelled() {
  confirmingRebuild.value = false
}

// A poll can retire the output while the dialog is open, and the dialog names that book and promises
// to delete it. Once the row is no longer ready there is nothing to replace, so the question goes.
watch(rowState, (next) => {
  if (next !== 'ready') confirmingRebuild.value = false
})
</script>

<template>
  <div class="relative flex items-start gap-2 rounded-lg border border-border bg-background p-2.5" data-testid="read-along-row">
    <component :is="rowIcon" class="mt-0.5 size-3.5 shrink-0" :class="rowIconClass" :aria-label="t('book.detail.editionLink.readAlong.label')" />

    <Tooltip v-if="showDestinationHint">
      <TooltipTrigger as-child>
        <button
          type="button"
          class="absolute top-2 right-2 text-muted-foreground transition-colors hover:text-foreground"
          :aria-label="destinationHint"
          data-testid="read-along-destination"
        >
          <Info class="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ destinationHint }}</TooltipContent>
    </Tooltip>

    <div class="min-w-0 flex-1">
      <p class="text-[11px] text-muted-foreground">{{ t('book.detail.editionLink.readAlong.label') }}</p>

      <template v-if="rowState === 'ready'">
        <p v-if="member" class="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
          <RouterLink :to="memberRoute" class="truncate hover:underline">{{ memberTitle }}</RouterLink>
          <span v-if="isCurrentBook" class="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
            {{ t('book.detail.editionLink.readAlong.thisBook') }}
          </span>
        </p>
        <p v-else class="mt-0.5 text-sm font-medium text-foreground" data-testid="read-along-ready-pending">
          {{ t('book.detail.editionLink.readAlong.readyPending') }}
        </p>
        <p v-if="textProgressLabel" class="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="read-along-progress">
          <span>{{ textProgressLabel }}</span>
          <template v-if="narrationProgressLabel">
            <span aria-hidden="true">/</span>
            <span>{{ narrationProgressLabel }}</span>
          </template>
        </p>
        <button
          v-if="canGenerate && canRebuild"
          type="button"
          class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="actionDisabled"
          data-testid="read-along-rebuild"
          @click="handleRebuild"
        >
          <RefreshCw class="size-3.5" />
          {{ t('book.detail.editionLink.readAlong.rebuild') }}
        </button>
      </template>

      <template v-else-if="rowState === 'outOfReach'">
        <p class="mt-0.5 text-sm font-medium text-foreground" data-testid="read-along-out-of-reach">
          {{ t('book.detail.editionLink.readAlong.outOfReachTitle') }}
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.readAlong.outOfReachHint') }}</p>
      </template>

      <template v-else-if="rowState === 'building'">
        <p class="mt-0.5 text-sm font-medium text-foreground" data-testid="read-along-building">{{ phaseLabel }}</p>
        <p v-if="stageLabel" class="mt-0.5 text-xs text-muted-foreground" data-testid="read-along-stage">{{ stageLabel }}</p>
        <div v-if="remotePercentage !== null" class="mt-1.5 flex items-center gap-2">
          <div
            class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            :aria-valuenow="remotePercentage"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="stageLabel ?? phaseLabel"
          >
            <div class="h-full rounded-full bg-primary transition-[width] duration-500" :style="{ width: `${remotePercentage}%` }" />
          </div>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="read-along-progress">{{ remotePercentage }}%</span>
        </div>
      </template>

      <template v-else-if="rowState === 'failed'">
        <p class="mt-0.5 text-sm font-medium text-destructive" data-testid="read-along-failed">
          {{ t('book.detail.editionLink.readAlong.failedTitle') }}
        </p>
        <p class="mt-0.5 text-xs break-words text-muted-foreground">{{ failureMessage }}</p>
        <button
          v-if="canGenerate"
          type="button"
          class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="actionDisabled"
          data-testid="read-along-retry"
          @click="handleRetry"
        >
          <RefreshCw class="size-3.5" />
          {{ t('book.detail.editionLink.readAlong.retry') }}
        </button>
      </template>

      <template v-else>
        <p v-if="!canGenerate" class="mt-0.5 text-xs text-muted-foreground" data-testid="read-along-none">
          {{ t('book.detail.editionLink.readAlong.noneTitle') }}
        </p>
        <template v-else>
          <button
            type="button"
            class="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="actionDisabled"
            data-testid="read-along-generate"
            @click="handleGenerate"
          >
            <Loader2 v-if="state.mutating" class="size-3.5 animate-spin" />
            <Sparkles v-else class="size-3.5" />
            {{ t('book.detail.editionLink.readAlong.generate') }}
          </button>
          <button
            v-if="importMatch"
            type="button"
            class="mt-1.5 block w-full truncate rounded-md border border-input px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="state.mutating"
            data-testid="read-along-import"
            @click="handleImportExisting"
          >
            {{ t('book.detail.editionLink.readAlong.importExisting', { title: importMatch.title }) }}
          </button>
          <div class="mt-2 flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
            <template v-if="state.remoteCopyReclaimable">
              <ToggleSwitch
                :model-value="state.keepRemoteCopy"
                :disabled="state.mutating"
                :aria-labelledby="keepCopyLabelId"
                data-testid="read-along-keep-copy"
                @update:model-value="handleKeepRemoteCopy"
              />
              <span :id="keepCopyLabelId">{{ t('book.detail.editionLink.readAlong.keepCopy.label') }}</span>
            </template>
            <span v-else data-testid="read-along-keep-copy-moot">{{ t('book.detail.editionLink.readAlong.keepCopy.notApplicable') }}</span>
            <Tooltip v-if="state.remoteCopyReclaimable">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="text-muted-foreground transition-colors hover:text-foreground"
                  :aria-label="keepCopyHint"
                  data-testid="read-along-keep-copy-hint"
                >
                  <Info class="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent class="max-w-72">{{ keepCopyHint }}</TooltipContent>
            </Tooltip>
          </div>
        </template>
      </template>

      <p v-if="blockMessage && canGenerate" class="mt-1.5 text-xs text-muted-foreground" data-testid="read-along-blocked">{{ blockMessage }}</p>
    </div>

    <ConfirmDialog
      :open="confirmingRebuild"
      :title="t('book.detail.editionLink.readAlong.rebuildDialog.title')"
      :description="t('book.detail.editionLink.readAlong.rebuildDialog.description', { title: memberTitle })"
      :confirm-label="t('book.detail.editionLink.readAlong.rebuildDialog.confirm')"
      :busy="state.mutating"
      @confirm="handleRebuildConfirmed"
      @cancel="handleRebuildCancelled"
    />
  </div>
</template>
