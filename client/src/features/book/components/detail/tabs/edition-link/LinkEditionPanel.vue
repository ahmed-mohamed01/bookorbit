<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link2, Loader2, Unlink2 } from '@lucide/vue'
import type { EditionLinkCandidate } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import type { LinkEditionPanelView } from '@/features/book/composables/useLinkEditionPanel'
import EditionPairBox from './EditionPairBox.vue'
import PositionSyncSection from './PositionSyncSection.vue'
import ReadAlongSection from './ReadAlongSection.vue'

const props = defineProps<{ panel: LinkEditionPanelView }>()

const { t } = useI18n()

const chipClass = computed(() => {
  switch (props.panel.phase) {
    case 'linked':
      return 'bg-success/15 text-success'
    case 'linking':
      return 'bg-info/15 text-info'
    default:
      return 'bg-muted text-muted-foreground'
  }
})

const readAlongOutput = computed(() => props.panel.readAlongMember)
const isReadAlongOutputCurrent = computed(() => props.panel.readAlongIsCurrentBook)
const unlinkNoteKey = computed(() =>
  props.panel.readAlongMember ? 'book.detail.editionLink.footer.unlinkNoteReadAlong' : 'book.detail.editionLink.footer.unlinkNote',
)

function handleChange() {
  props.panel.changeSelection()
}

function handlePick(candidate: EditionLinkCandidate) {
  props.panel.selectCandidate(candidate)
}

function handleQuery(value: string) {
  props.panel.setQuery(value)
}

function handleBuildSync(force: boolean) {
  void props.panel.buildSync(force)
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

function handleStartLink() {
  void props.panel.startLink()
}

function handleCancel() {
  void props.panel.cancelLinking()
}

function handleUnlink() {
  void props.panel.unlink()
}
</script>

<template>
  <div data-testid="link-edition-panel" :data-phase="panel.phase">
    <div class="flex items-center gap-2.5">
      <h2 class="min-w-0 flex-1 text-base font-semibold text-foreground">{{ t('book.detail.editionLink.title') }}</h2>
      <span
        v-if="!panel.initialLoading"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
        :class="chipClass"
        aria-live="polite"
        data-testid="link-edition-chip"
      >
        <span v-if="panel.phase === 'linking'" class="size-2 animate-spin rounded-full border-2 border-info/30 border-t-info" aria-hidden="true" />
        {{ t(panel.chipKey) }}
      </span>
    </div>

    <div v-if="panel.initialLoading" class="mt-3 space-y-2">
      <div class="h-4 w-3/4 animate-shimmer rounded bg-muted" />
      <div class="h-24 w-full animate-shimmer rounded-xl bg-muted" />
    </div>

    <template v-else>
      <p class="mt-1 mb-3 text-[13px] text-pretty text-muted-foreground" data-testid="link-edition-intro">{{ t(panel.introKey) }}</p>

      <EditionPairBox
        :phase="panel.phase"
        :slots="panel.slots"
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
      />

      <template v-if="panel.showSections">
        <PositionSyncSection
          v-if="!panel.isReadAlongPage"
          :status="panel.syncStatus"
          :samples-done="panel.alignment.samplesDone"
          :samples-total="panel.alignment.samplesTotal"
          :built-at="panel.alignment.builtAt"
          :build-blocked="panel.alignment.buildBlocked"
          :mutating="panel.alignment.mutating"
          :can-build="panel.canBuildSync"
          :counterpart-modality="panel.link ? panel.counterpartFormat : null"
          @build="handleBuildSync"
        />

        <ReadAlongSection
          v-if="panel.showReadAlong"
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

        <template v-if="!panel.isReadAlongPage">
          <Button
            v-if="panel.phase === 'matched' && panel.canEditMetadata"
            class="mt-3 h-10 w-full text-sm font-semibold"
            :disabled="panel.mutating"
            data-testid="link-edition-cta"
            @click="handleStartLink"
          >
            <Loader2 v-if="panel.mutating" class="size-4 animate-spin" aria-hidden="true" />
            <Link2 v-else class="size-4" aria-hidden="true" />
            {{ t(panel.ctaKey) }}
          </Button>

          <div v-else-if="panel.phase === 'linking'" class="mt-3 flex items-center gap-2.5" data-testid="link-edition-linking-footer">
            <p class="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">{{ t('book.detail.editionLink.footer.linkingNote') }}</p>
            <Button
              v-if="panel.canEditMetadata"
              variant="ghost"
              size="sm"
              class="h-8 shrink-0 text-xs"
              :disabled="panel.mutating"
              data-testid="link-edition-cancel"
              @click="handleCancel"
            >
              {{ t('common.cancel') }}
            </Button>
          </div>

          <div
            v-else-if="panel.phase === 'linked' && panel.canEditMetadata"
            class="mt-3 flex items-center gap-3"
            data-testid="link-edition-linked-footer"
          >
            <Button
              variant="destructive-outline"
              size="sm"
              class="h-8 shrink-0 text-xs"
              :disabled="panel.mutating"
              data-testid="link-edition-unlink"
              @click="handleUnlink"
            >
              <Loader2 v-if="panel.mutating" class="size-3.5 animate-spin" aria-hidden="true" />
              <Unlink2 v-else class="size-3.5" aria-hidden="true" />
              {{ t('book.detail.editionLink.unlink') }}
            </Button>
            <p class="min-w-0 text-xs text-pretty text-muted-foreground" data-testid="link-edition-unlink-note">{{ t(unlinkNoteKey) }}</p>
          </div>
        </template>
      </template>
    </template>
  </div>
</template>
