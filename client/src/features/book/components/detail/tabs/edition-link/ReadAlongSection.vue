<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio, Loader2, RefreshCw, Sparkles, X } from '@lucide/vue'
import type { EditionLinkMember, ReadAlongBlockReason, StorytellerExistingMatch } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import type { ReadAlongSectionState } from '@/features/book/composables/useReadAlong'
import { isTickBlockReason } from '@/features/book/lib/read-along-blocks'
import {
  isActionBlocked,
  resolveReadAlongSectionState,
  stageIndex,
  type ReadAlongDisplayState,
  type ReadAlongSectionMode,
} from '@/features/book/lib/read-along-section'

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

const UNREACHABLE_REASONS = new Set<ReadAlongBlockReason>(['not_configured', 'unreachable'])

const STAGE_KEYS = [
  'book.detail.editionLink.readAlong.stages.sending',
  'book.detail.editionLink.readAlong.stages.transcribing',
  'book.detail.editionLink.readAlong.stages.aligning',
  'book.detail.editionLink.readAlong.stages.importing',
] as const

const props = withDefaults(
  defineProps<{
    mode: ReadAlongSectionMode
    state: ReadAlongSectionState
    member: EditionLinkMember | null
    isCurrentBook?: boolean
    canGenerate: boolean
    canRebuild: boolean
    existingMatch?: StorytellerExistingMatch | null
    generateOnLink?: boolean
    canToggle?: boolean
    toggleDisabled?: boolean
    keepCopyOffered: boolean
    targetLibraries?: { id: number; name: string }[]
    chosenTargetLibraryId?: number | null
    targetLibraryName?: string | null
  }>(),
  {
    isCurrentBook: false,
    existingMatch: null,
    generateOnLink: false,
    canToggle: false,
    toggleDisabled: false,
    targetLibraries: () => [],
    chosenTargetLibraryId: null,
    targetLibraryName: null,
  },
)

const emit = defineEmits<{
  'update:generateOnLink': [value: boolean]
  'update:keepRemoteCopy': [value: boolean]
  'update:targetLibraryId': [value: number | null]
  generate: []
  importExisting: [uuid: string]
  retry: []
  rebuild: []
  cancel: []
}>()

const { t } = useI18n()
const keepCopyLabelId = `read-along-keep-copy-${useId()}`
const destinationSelectId = `read-along-destination-${useId()}`

const sectionState = computed<ReadAlongDisplayState>(() =>
  resolveReadAlongSectionState(props.mode, props.state, props.member !== null, props.generateOnLink, props.toggleDisabled),
)

// Before a link the server answers 'no_pair' (and other pair-shaped reasons) for every book, which the
// link itself resolves, so an offer only speaks up for a blocker linking cannot clear.
const blocked = computed(() => {
  if (props.mode === 'readOnly') return null
  const reason = props.state.blocked
  if (props.mode === 'offer') return isTickBlockReason(reason) ? reason : null
  return reason
})
const blockMessage = computed(() => (blocked.value && props.canGenerate ? t(BLOCK_MESSAGE_KEYS[blocked.value]) : null))

const tag = computed(() => {
  switch (sectionState.value) {
    case 'building':
      return { key: 'book.detail.editionLink.readAlong.tag.building', class: 'bg-info/15 text-info' }
    case 'failed':
      return { key: 'book.detail.editionLink.readAlong.tag.failed', class: 'bg-destructive/15 text-destructive' }
    case 'ready':
    case 'outOfReach':
      return { key: 'book.detail.editionLink.readAlong.tag.ready', class: 'bg-success/15 text-success' }
    default:
      if (blocked.value && UNREACHABLE_REASONS.has(blocked.value)) {
        return { key: 'book.detail.editionLink.readAlong.tag.unreachable', class: 'bg-muted text-muted-foreground' }
      }
      return null
  }
})

const actionDisabled = computed(() => props.state.mutating || isActionBlocked(props.state.blocked))

const showToggle = computed(() => props.mode === 'offer' && props.canToggle)
const showGenerate = computed(() => sectionState.value === 'none' && props.canGenerate)
const showRetry = computed(() => sectionState.value === 'failed' && props.canGenerate)
const showCancel = computed(() => sectionState.value === 'building' && props.canGenerate)
const showRebuild = computed(() => props.mode === 'manage' && sectionState.value === 'ready' && props.canGenerate && props.canRebuild)

// Only an aligned Storyteller book can be imported: an unaligned one still has to be processed.
const importMatch = computed(() => (sectionState.value === 'none' && props.canGenerate && props.existingMatch?.aligned ? props.existingMatch : null))

// A choice made after the build has started would change nothing, so it is only offered before one.
const showKeepCopy = computed(
  () => props.keepCopyOffered && (sectionState.value === 'offerOn' || (sectionState.value === 'none' && props.canGenerate)),
)
const keepCopyHint = computed(() =>
  props.state.keepRemoteCopy ? t('book.detail.editionLink.readAlong.keepCopy.hintKeep') : t('book.detail.editionLink.readAlong.keepCopy.hintRemove'),
)

const showDestination = computed(() => sectionState.value === 'offerOn' || (sectionState.value === 'none' && props.canGenerate))
const destinationText = computed(() =>
  props.targetLibraryName
    ? t('book.detail.editionLink.readAlong.destination.willBeAdded', { library: props.targetLibraryName })
    : t('book.detail.editionLink.readAlong.destination.willBeAddedDefault'),
)
const destinationOpen = ref(false)
const destinationModel = computed({
  get: () => props.chosenTargetLibraryId,
  set: (value: number | null) => emit('update:targetLibraryId', value),
})

const currentStage = computed(() => stageIndex(props.state.phase, props.state.remoteTask))
const stages = computed(() =>
  STAGE_KEYS.map((key, index) => {
    if (index < currentStage.value) return { key, state: 'done' as const }
    if (index === currentStage.value) return { key, state: 'current' as const }
    return { key, state: 'todo' as const }
  }),
)

const buildPercent = computed(() => {
  if (props.state.phase !== 'wait') return null
  const progress = props.state.remoteProgress
  if (typeof progress !== 'number' || Number.isNaN(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress * 100)))
})

const failureMessage = computed(() => props.state.error ?? t('book.detail.editionLink.readAlong.failedFallback'))

const memberTitle = computed(() => props.member?.title ?? t('book.detail.editionLink.readAlong.readyPending'))
const memberRoute = computed(() => ({ name: 'book-detail', params: { bookId: props.member?.id } }))

const memberProgress = computed(() => {
  const readValue = props.member?.progress?.percentage
  const listenedValue = props.member?.narrationPercentage
  const read = typeof readValue === 'number' ? t('book.detail.editionLink.progressRead', { percentage: Math.round(readValue) }) : null
  const listened = typeof listenedValue === 'number' ? t('book.detail.editionLink.progressListened', { percentage: Math.round(listenedValue) }) : null
  if (read && listened) return t('book.detail.editionLink.readAlong.progressBoth', { read, listened })
  return read ?? listened
})

const bodyText = computed(() => {
  switch (sectionState.value) {
    case 'offerOn':
      return t('book.detail.editionLink.readAlong.body.offerOn')
    case 'offerOff':
      return t('book.detail.editionLink.readAlong.body.offerOff')
    case 'none':
      return t('book.detail.editionLink.readAlong.body.none')
    case 'outOfReach':
      return t('book.detail.editionLink.readAlong.body.outOfReach')
    default:
      return null
  }
})

function handleToggle(value: boolean) {
  emit('update:generateOnLink', value)
}

function handleKeepCopy(value: boolean) {
  emit('update:keepRemoteCopy', value)
}

function handleRevealDestination() {
  destinationOpen.value = true
}

function handleGenerate() {
  emit('generate')
}

function handleImportExisting() {
  if (importMatch.value) emit('importExisting', importMatch.value.uuid)
}

function handleCancel() {
  emit('cancel')
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
// to delete it. Once the section is no longer ready there is nothing to replace, so the question goes.
watch(sectionState, (next) => {
  if (next !== 'ready') confirmingRebuild.value = false
})
</script>

<template>
  <section class="mt-2.5 rounded-xl border border-border bg-background p-3" :data-state="sectionState" data-testid="read-along-section">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <BookAudio class="size-3.5 shrink-0 text-info" aria-hidden="true" />
      <h3 class="text-sm font-semibold text-foreground">{{ t('book.detail.editionLink.readAlong.title') }}</h3>
      <span class="text-[11px] text-muted-foreground">{{ t('book.detail.editionLink.readAlong.via') }}</span>
      <div class="ms-auto flex items-center gap-2">
        <Button
          v-if="showCancel"
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs"
          :disabled="state.mutating"
          :aria-label="t('book.detail.editionLink.readAlong.cancelLabel')"
          data-testid="read-along-cancel"
          @click="handleCancel"
        >
          <X class="size-3.5" aria-hidden="true" />
          {{ t('book.detail.editionLink.readAlong.cancel') }}
        </Button>
        <span v-if="tag" class="rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap" :class="tag.class" data-testid="read-along-tag">
          {{ t(tag.key) }}
        </span>
        <ToggleSwitch
          v-if="showToggle"
          :model-value="generateOnLink"
          :disabled="toggleDisabled"
          :aria-label="t('book.detail.editionLink.readAlong.generateToggle')"
          data-testid="read-along-toggle"
          @update:model-value="handleToggle"
        />
        <Button
          v-if="showGenerate"
          size="sm"
          class="h-8 px-2.5 text-xs"
          :disabled="actionDisabled"
          data-testid="read-along-generate"
          @click="handleGenerate"
        >
          <Loader2 v-if="state.mutating" class="size-3.5 animate-spin" aria-hidden="true" />
          <Sparkles v-else class="size-3.5" aria-hidden="true" />
          {{ t('book.detail.editionLink.readAlong.generate') }}
        </Button>
        <Button
          v-if="showRetry"
          variant="ghost"
          size="sm"
          class="h-8 px-2 text-xs"
          :disabled="actionDisabled"
          data-testid="read-along-retry"
          @click="handleRetry"
        >
          <RefreshCw class="size-3.5" aria-hidden="true" />
          {{ t('book.detail.editionLink.readAlong.retry') }}
        </Button>
      </div>
    </div>

    <p v-if="bodyText" class="mt-1.5 text-xs text-pretty text-muted-foreground" data-testid="read-along-body">{{ bodyText }}</p>

    <button
      v-if="importMatch"
      type="button"
      class="mt-1.5 block max-w-full truncate text-start text-xs text-info hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="state.mutating"
      data-testid="read-along-import"
      @click="handleImportExisting"
    >
      {{ t('book.detail.editionLink.readAlong.importExisting', { title: importMatch.title }) }}
    </button>

    <template v-if="sectionState === 'building'">
      <div class="mt-2.5 flex items-center gap-2.5">
        <div
          class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="buildPercent ?? undefined"
          :aria-label="t('book.detail.editionLink.readAlong.progressLabel')"
          data-testid="read-along-bar"
        >
          <div
            v-if="buildPercent !== null"
            class="h-full rounded-full bg-info transition-[width] duration-500"
            :style="{ width: `${buildPercent}%` }"
          />
          <div v-else class="h-full w-full animate-pulse rounded-full bg-info/40" data-testid="read-along-bar-indeterminate" />
        </div>
        <span
          v-if="buildPercent !== null"
          class="w-10 shrink-0 text-end text-xs font-semibold tabular-nums text-muted-foreground"
          data-testid="read-along-percent"
        >
          {{ t('book.detail.editionLink.readAlong.percent', { percent: buildPercent }) }}
        </span>
      </div>
      <ol class="mt-2 flex flex-wrap gap-x-3.5 gap-y-1" data-testid="read-along-stages">
        <li
          v-for="stage in stages"
          :key="stage.key"
          class="flex items-center gap-1.5 text-[11px]"
          :class="stage.state === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground'"
          :data-stage-state="stage.state"
          data-testid="read-along-stage"
        >
          <span
            class="size-[7px] shrink-0 rounded-full"
            :class="{
              'bg-success': stage.state === 'done',
              'animate-pulse bg-info': stage.state === 'current',
              'bg-border': stage.state === 'todo',
            }"
            aria-hidden="true"
          />
          {{ t(stage.key) }}
        </li>
      </ol>
    </template>

    <p v-else-if="sectionState === 'failed'" class="mt-1.5 text-xs break-words text-muted-foreground" data-testid="read-along-error">
      {{ failureMessage }}
    </p>

    <div v-else-if="sectionState === 'ready'" class="mt-2 flex items-center gap-2.5" data-testid="read-along-ready">
      <div class="min-w-0 flex-1">
        <p class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
          <RouterLink v-if="member && !isCurrentBook" :to="memberRoute" class="truncate hover:underline">{{ memberTitle }}</RouterLink>
          <span v-else class="truncate">{{ memberTitle }}</span>
          <span
            v-if="isCurrentBook"
            class="rounded-md bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground"
            data-testid="read-along-this-book"
          >
            {{ t('book.detail.editionLink.thisBook') }}
          </span>
        </p>
        <p v-if="state.targetLibraryName && mode !== 'readOnly'" class="mt-0.5 truncate text-xs text-muted-foreground">
          {{ t('book.detail.editionLink.readAlong.addedTo', { library: state.targetLibraryName }) }}
        </p>
        <p v-if="memberProgress" class="mt-0.5 text-xs text-muted-foreground" data-testid="read-along-progress">{{ memberProgress }}</p>
      </div>
      <Button
        v-if="showRebuild"
        variant="outline"
        size="sm"
        class="h-8 shrink-0 px-2 text-xs"
        :disabled="actionDisabled"
        data-testid="read-along-rebuild"
        @click="handleRebuild"
      >
        <RefreshCw class="size-3.5" aria-hidden="true" />
        {{ t('book.detail.editionLink.readAlong.rebuild') }}
      </Button>
    </div>

    <p v-if="blockMessage" class="mt-1.5 text-xs text-muted-foreground" data-testid="read-along-blocked">{{ blockMessage }}</p>

    <div v-if="showKeepCopy" class="mt-2.5 flex items-center gap-2.5 border-t border-border pt-2.5" data-testid="read-along-keep-copy-row">
      <div class="min-w-0 flex-1">
        <p :id="keepCopyLabelId" class="text-xs text-foreground">{{ t('book.detail.editionLink.readAlong.keepCopy.label') }}</p>
        <p class="mt-px text-[11px] text-muted-foreground" data-testid="read-along-keep-copy-hint">{{ keepCopyHint }}</p>
      </div>
      <ToggleSwitch
        :model-value="state.keepRemoteCopy"
        :disabled="state.mutating"
        :aria-labelledby="keepCopyLabelId"
        data-testid="read-along-keep-copy"
        @update:model-value="handleKeepCopy"
      />
    </div>

    <div v-if="showDestination" class="mt-2.5 text-xs text-muted-foreground" data-testid="read-along-destination">
      <p class="flex flex-wrap items-center gap-x-1.5">
        <span>{{ destinationText }}</span>
        <button
          v-if="!destinationOpen && targetLibraries.length"
          type="button"
          class="text-info hover:underline"
          data-testid="read-along-destination-change"
          @click="handleRevealDestination"
        >
          {{ t('book.detail.editionLink.readAlong.destination.change') }}
        </button>
      </p>
      <template v-if="destinationOpen">
        <label :for="destinationSelectId" class="sr-only">{{ t('book.detail.editionLink.readAlong.destination.label') }}</label>
        <select
          :id="destinationSelectId"
          v-model="destinationModel"
          class="mt-1.5 h-8 w-full rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          data-testid="read-along-destination-select"
        >
          <option :value="null">{{ t('book.detail.editionLink.readAlong.destination.placeholder') }}</option>
          <option v-for="library in targetLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
        </select>
      </template>
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
  </section>
</template>
