<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Activity, Loader2, RefreshCw } from '@lucide/vue'
import type { EditionLinkCandidate } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { isActionBlocked } from '@/features/book/lib/read-along-section'
import type { LinkEditionPanelView, PairSyncState } from '@/features/book/composables/useLinkEditionPanel'
import EditionPairBox from './EditionPairBox.vue'
import { usePositionSyncStatus } from '@/features/book/composables/usePositionSyncStatus'
import { needsForce } from '@/features/book/lib/position-sync'
import PositionSyncTicks from './PositionSyncTicks.vue'
import ReadAlongSection from './ReadAlongSection.vue'

const props = defineProps<{ panel: LinkEditionPanelView }>()

const { t } = useI18n()

const sync = usePositionSyncStatus(() => ({
  status: props.panel.syncStatus,
  builtAt: props.panel.alignment.builtAt,
  buildBlocked: props.panel.alignment.buildBlocked,
  canBuild: props.panel.canBuildSync,
}))

// Once linked, the header narrates position sync itself, so the pair's state and its sync state share
// one chip: an established, synced pair reads Linked, anything else names the sync problem.
const tracksSync = computed(() => props.panel.phase === 'linked' && props.panel.link !== null)
const syncChip = computed(() => (tracksSync.value && props.panel.syncStatus !== 'ready' ? sync.tag.value : null))

const introText = computed(() => {
  if (tracksSync.value && props.panel.syncStatus === 'failed') return t('book.detail.readingAlignment.failedHint')
  if (tracksSync.value && props.panel.syncStatus === 'unalignable') return t('book.detail.readingAlignment.unalignableHint')
  return t(props.panel.introKey)
})

const pairSyncState = computed<PairSyncState>(() => {
  if (sync.running.value || props.panel.alignment.mutating) return 'syncing'
  return ['none', 'failed', 'unalignable'].includes(props.panel.syncStatus) ? 'unsynced' : 'synced'
})
const showTicks = computed(() => props.panel.phase === 'linking' || (tracksSync.value && sync.running.value))
const showSyncButton = computed(() => tracksSync.value && sync.showBuildButton.value)
const syncShortLabel = computed(() =>
  sync.isRebuild.value ? t('book.detail.editionLink.actions.rebuild') : t('book.detail.editionLink.actions.build'),
)
const syncActionLabel = computed(() =>
  sync.isRebuild.value ? t('book.detail.editionLink.actions.rebuildSync') : t('book.detail.editionLink.actions.buildSync'),
)

const chipClass = computed(() => {
  if (syncChip.value) return syncChip.value.class
  switch (props.panel.phase) {
    case 'linked':
      return 'bg-success/15 text-success'
    case 'linking':
      return 'bg-info/15 text-info'
    default:
      return 'bg-muted text-muted-foreground'
  }
})

// The footer stays pinned to the popover's bottom edge so the primary action never needs a scroll to reach.
// The toggle is the link: on links the pair (or keeps it), off cancels a link in progress or unlinks.
// Its state already says linked or not, so the chip only speaks up for a sync that needs attention,
// except to a viewer who cannot toggle and so has only the chip to read.
const showSyncToggle = computed(() => props.panel.canEditMetadata && props.panel.phase !== 'nomatch')
const syncToggleOn = computed(() => props.panel.phase === 'linking' || props.panel.phase === 'linked')
const showChip = computed(() => syncChip.value !== null || !showSyncToggle.value)

const readAlongOutput = computed(() => props.panel.readAlongMember)
const isReadAlongOutputCurrent = computed(() => props.panel.readAlongIsCurrentBook)

// The pair's timeline already shows a ready read-along as its third edition, so its section would only
// repeat it. A rebuild moves the status off ready and brings the section back to narrate it.
const readAlongReady = computed(() => props.panel.readAlongSlot !== null && props.panel.readAlongSection.sectionState.status === 'ready')
const showReadAlongSection = computed(() => props.panel.showReadAlong && !readAlongReady.value)

const canRebuildReadAlong = computed(
  () => readAlongReady.value && props.panel.readAlongSection.canGenerate && props.panel.readAlongSection.canRebuild,
)
const readAlongRebuildDisabled = computed(
  () => props.panel.readAlongSection.sectionState.mutating || isActionBlocked(props.panel.readAlongSection.sectionState.blocked),
)
const readAlongTitle = computed(() => props.panel.readAlongSlot?.title ?? t('book.detail.editionLink.readAlong.readyPending'))

const confirmingUnlink = ref(false)
const confirmingReadAlongRebuild = ref(false)
const unlinkDescription = computed(() =>
  props.panel.readAlongMember
    ? t('book.detail.editionLink.unlinkDialog.descriptionReadAlong')
    : t('book.detail.editionLink.unlinkDialog.description'),
)

function handleUnlinkCancelled() {
  confirmingUnlink.value = false
}

function handleReadAlongRebuildRequest() {
  confirmingReadAlongRebuild.value = true
}

function handleReadAlongRebuildCancelled() {
  confirmingReadAlongRebuild.value = false
}

function handleReadAlongRebuildConfirmed() {
  confirmingReadAlongRebuild.value = false
  props.panel.readAlongSection.handleRebuild()
}

function handleChange() {
  props.panel.changeSelection()
}

function handlePick(candidate: EditionLinkCandidate) {
  props.panel.selectCandidate(candidate)
}

function handleQuery(value: string) {
  props.panel.setQuery(value)
}

function handleBuildSync() {
  void props.panel.buildSync(needsForce(props.panel.syncStatus))
}

function handleGenerateOnLink(value: boolean) {
  props.panel.setGenerateOnLink(value)
}

function handleKeepRemoteCopy(value: boolean) {
  props.panel.readAlongSection.readAlong.setKeepRemoteCopy(value)
}

function handleTargetLibrary(value: number | null) {
  props.panel.readAlongSection.setTargetLibrary(value)
}

function handleGenerate() {
  props.panel.readAlongSection.handleGenerate()
}

function handleImportExisting(uuid: string) {
  props.panel.readAlongSection.handleImportExisting(uuid)
}

function handleRetry() {
  props.panel.readAlongSection.handleRetry()
}

function handleCancelReadAlong() {
  void props.panel.readAlongSection.handleCancel()
}

function handleRebuild() {
  props.panel.readAlongSection.handleRebuild()
}

function handleSyncToggle(value: boolean) {
  if (value) {
    if (props.panel.phase === 'matched') void props.panel.startLink()
    return
  }
  if (props.panel.phase === 'linking') void props.panel.cancelLinking()
  else if (props.panel.phase === 'linked') confirmingUnlink.value = true
}

async function handleUnlink() {
  await props.panel.unlink()
  confirmingUnlink.value = false
}
</script>

<template>
  <div data-testid="link-edition-panel" :data-phase="panel.phase">
    <div class="flex items-center gap-2">
      <Activity class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{{ t('book.detail.readingAlignment.title') }}</h2>
      <template v-if="!panel.initialLoading">
        <span
          v-if="showChip"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
          :class="chipClass"
          aria-live="polite"
          data-testid="link-edition-chip"
        >
          <span v-if="showTicks" class="size-2 animate-spin rounded-full border-2 border-info/30 border-t-info" aria-hidden="true" />
          {{ syncChip ? t(syncChip.key) : t(panel.chipKey) }}
        </span>
        <Button
          v-if="showSyncButton"
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
          :disabled="panel.alignment.mutating"
          :aria-label="syncActionLabel"
          data-testid="position-sync-build"
          @click="handleBuildSync"
        >
          <Loader2 v-if="panel.alignment.mutating" class="size-3.5 animate-spin" aria-hidden="true" />
          <RefreshCw v-else class="size-3.5" aria-hidden="true" />
          {{ syncShortLabel }}
        </Button>
        <ToggleSwitch
          v-if="showSyncToggle"
          :model-value="syncToggleOn"
          :disabled="panel.mutating"
          :aria-label="t('book.detail.readingAlignment.title')"
          data-testid="position-sync-toggle"
          @update:model-value="handleSyncToggle"
        />
      </template>
    </div>

    <div v-if="panel.initialLoading" class="mt-3 space-y-2">
      <div class="h-4 w-3/4 animate-shimmer rounded bg-muted" />
      <div class="h-24 w-full animate-shimmer rounded-xl bg-muted" />
    </div>

    <template v-else>
      <div class="mb-2">
        <p class="mt-0.5 text-xs text-pretty text-muted-foreground" data-testid="link-edition-intro">{{ introText }}</p>
        <p
          v-if="tracksSync && panel.syncStatus === 'failed' && panel.alignment.buildError"
          class="mt-0.5 text-xs break-words text-muted-foreground"
          data-testid="position-sync-build-error"
        >
          {{ panel.alignment.buildError }}
        </p>
        <p v-if="tracksSync && sync.blockMessage.value" class="mt-0.5 text-xs text-muted-foreground" data-testid="position-sync-blocked">
          {{ sync.blockMessage.value }}
        </p>
        <PositionSyncTicks v-if="showTicks" class="mt-2" :samples-done="panel.alignment.samplesDone" :samples-total="panel.alignment.samplesTotal" />
      </div>

      <EditionPairBox
        :phase="panel.phase"
        :slots="panel.slots"
        :read-along="panel.readAlongSlot"
        :sync-state="pairSyncState"
        :read-along-rebuild-label="canRebuildReadAlong ? t('book.detail.editionLink.actions.rebuildReadAlong') : null"
        :read-along-rebuild-disabled="readAlongRebuildDisabled"
        :can-search="panel.canEditMetadata"
        :query="panel.query"
        :candidates="panel.candidates"
        :searching="panel.searching"
        :search-error="panel.searchError"
        :has-searched="panel.hasSearched"
        :search-autofocus="panel.searchAutofocus"
        :disabled="panel.mutating"
        @change="handleChange"
        @pick="handlePick"
        @update:query="handleQuery"
        @rebuild-read-along="handleReadAlongRebuildRequest"
      />

      <template v-if="panel.showSections">
        <div v-if="showReadAlongSection" class="mt-2 border-t border-border" data-testid="link-edition-sections">
          <ReadAlongSection
            class="mt-0! rounded-none! border-x-0! border-t-0! border-border/60! bg-transparent! px-0! last:border-b-0!"
            :mode="panel.readAlongMode"
            :state="panel.readAlongSection.sectionState"
            :member="readAlongOutput"
            :is-current-book="isReadAlongOutputCurrent"
            :can-generate="panel.readAlongSection.canGenerate"
            :can-rebuild="panel.readAlongSection.canRebuild"
            :existing-match="panel.readAlongSection.existingMatch"
            :generate-on-link="panel.generateOnLink"
            :can-toggle="panel.canToggleReadAlong"
            :toggle-disabled="panel.toggleDisabled"
            :keep-copy-offered="panel.readAlongSection.keepCopyOffered"
            :target-libraries="panel.readAlongSection.targetLibraries"
            :chosen-target-library-id="panel.readAlongSection.chosenTargetLibraryId"
            :target-library-name="panel.readAlongSection.targetLibraryName"
            @update:generate-on-link="handleGenerateOnLink"
            @update:keep-remote-copy="handleKeepRemoteCopy"
            @update:target-library-id="handleTargetLibrary"
            @generate="handleGenerate"
            @import-existing="handleImportExisting"
            @retry="handleRetry"
            @cancel="handleCancelReadAlong"
            @rebuild="handleRebuild"
          />
        </div>
      </template>
    </template>

    <ConfirmDialog
      :open="confirmingUnlink"
      :title="t('book.detail.editionLink.unlinkDialog.title')"
      :description="unlinkDescription"
      :confirm-label="t('book.detail.editionLink.unlink')"
      :busy="panel.mutating"
      @confirm="handleUnlink"
      @cancel="handleUnlinkCancelled"
    />
    <ConfirmDialog
      :open="confirmingReadAlongRebuild"
      :title="t('book.detail.editionLink.readAlong.rebuildDialog.title')"
      :description="t('book.detail.editionLink.readAlong.rebuildDialog.description', { title: readAlongTitle })"
      :confirm-label="t('book.detail.editionLink.readAlong.rebuildDialog.confirm')"
      :busy="panel.readAlongSection.sectionState.mutating"
      @confirm="handleReadAlongRebuildConfirmed"
      @cancel="handleReadAlongRebuildCancelled"
    />
  </div>
</template>
