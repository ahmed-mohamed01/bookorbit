<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio, Library } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainAction, ChainActionId, ChainAvailableRow, EditionKey } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import EditionCover from './EditionCover.vue'
import ReadAlongBuildOptions from './ReadAlongBuildOptions.vue'
import ReadAlongStepper from './ReadAlongStepper.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'

const props = withDefaults(
  defineProps<{
    row: ChainAvailableRow
    expanded?: boolean
    logOpen?: boolean
    busy?: boolean
    options?: SyncChainPanelView['readAlongOptions'] | null
  }>(),
  { expanded: false, logOpen: false, busy: false, options: null },
)
const emit = defineEmits<{
  action: [id: ChainActionId, rowKey: string]
  'update:keepRemoteCopy': [value: boolean]
  'update:targetLibraryId': [value: number | null]
}>()

const { t } = useI18n()

const MEDIUM: Record<EditionKey, CoverMedium> = { ebook: 'ebook', readAlong: 'ebook', audiobook: 'audio', abs: 'audio' }
const HIDE_LOG: ChainAction['label'] = { key: 'book.detail.editionLink.chain.action.hideLog' }

const noteId = `sync-chain-available-note-${useId()}`
const settingsRoute = { name: 'settings-audiobookshelf' }

const bookCover = computed(() => (props.row.cover.kind === 'book' ? props.row.cover : null))
const secondary = computed(() =>
  props.row.secondary?.id === 'toggleLog' && props.logOpen ? { ...props.row.secondary, label: HIDE_LOG } : props.row.secondary,
)
const showOptions = computed(() => props.expanded && props.row.variant === 'readAlongNotGenerated' && props.options !== null)
const showLog = computed(() => props.logOpen && props.row.log)

const absCoverFailed = ref(false)
const absCoverSrc = computed(() => (props.row.cover.kind === 'abs' ? audiobookshelfCoverUrl(props.row.cover.absLibraryItemId) : null))
watch(absCoverSrc, () => {
  absCoverFailed.value = false
})

function handleAbsCoverError() {
  absCoverFailed.value = true
}

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}

function handleGenerate() {
  emit('action', 'generate', props.row.id)
}

function handleCancelGenerate() {
  emit('action', 'cancelGenerate', props.row.id)
}

function handleImportExisting() {
  emit('action', 'importExisting', props.row.id)
}

function handleKeepRemoteCopy(value: boolean) {
  emit('update:keepRemoteCopy', value)
}

function handleTargetLibrary(value: number | null) {
  emit('update:targetLibraryId', value)
}
</script>

<template>
  <div class="flex flex-col gap-2 py-1" :data-variant="row.variant" :data-edition="row.edition" data-testid="sync-chain-available-row">
    <div class="flex flex-col gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5">
      <div class="flex items-center gap-2.5">
        <div v-if="row.cover.kind !== 'none'" class="flex w-7 shrink-0 justify-center">
          <EditionCover
            v-if="bookCover"
            :book-id="bookCover.bookId"
            :medium="MEDIUM[row.edition]"
            :version="bookCover.coverVersion"
            size="mini"
            muted
          />
          <div
            v-else-if="row.cover.kind === 'abs'"
            class="size-7 shrink-0 overflow-hidden rounded bg-muted grayscale shadow-sm"
            data-testid="sync-chain-abs-cover"
          >
            <img
              v-if="!absCoverFailed && absCoverSrc"
              :src="absCoverSrc"
              alt=""
              loading="lazy"
              class="size-full object-cover"
              @error="handleAbsCoverError"
            />
            <div v-else class="flex size-full items-center justify-center text-muted-foreground">
              <Library class="size-3" aria-hidden="true" />
            </div>
          </div>
          <div
            v-else
            class="flex size-7 items-center justify-center rounded border border-border bg-muted text-muted-foreground"
            data-testid="sync-chain-read-along-tile"
          >
            <BookAudio class="size-3.5" aria-hidden="true" />
          </div>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-px">
          <span class="text-xs font-semibold text-foreground">{{ chainText(row.label, t) }}</span>
          <span :id="noteId" class="text-[11px] leading-snug text-pretty text-muted-foreground" data-testid="sync-chain-available-note">
            {{ chainText(row.note, t) }}
          </span>
        </div>
        <SyncChainActionButton
          v-if="row.action"
          :action="row.action"
          :disabled="busy"
          :aria-describedby="row.locked ? noteId : undefined"
          @action="handleAction"
        />
        <SyncChainActionButton v-if="row.cancel" :action="row.cancel" variant="cancel" :disabled="busy" @action="handleAction" />
      </div>
      <div v-if="secondary || row.settingsLink" class="flex flex-wrap items-center gap-3 ps-[38px]">
        <SyncChainActionButton v-if="secondary" :action="secondary" variant="link" :disabled="busy" @action="handleAction" />
        <RouterLink
          v-if="row.settingsLink"
          :to="settingsRoute"
          class="text-xs font-semibold text-info hover:underline"
          data-testid="sync-chain-available-settings"
        >
          {{ t('book.detail.editionLink.abs.settings') }}
        </RouterLink>
      </div>
    </div>

    <ReadAlongStepper
      v-if="row.job"
      class="ps-[50px] pe-1"
      :stage="row.job.stage"
      :remote-progress="row.job.remoteProgress"
      :failed="row.job.failed"
    />
    <p v-if="showLog" class="ps-[50px] pe-1 text-xs break-words text-muted-foreground" data-testid="sync-chain-available-log">{{ row.log }}</p>
    <ReadAlongBuildOptions
      v-if="showOptions && options"
      :keep-remote-copy="options.keepRemoteCopy"
      :reclaimable="options.reclaimable"
      :target-library-name="options.targetLibraryName"
      :target-libraries="options.targetLibraries"
      :chosen-target-library-id="options.chosenTargetLibraryId"
      :existing-match="options.existingMatch"
      :busy="options.busy"
      @update:keep-remote-copy="handleKeepRemoteCopy"
      @update:target-library-id="handleTargetLibrary"
      @generate="handleGenerate"
      @import-existing="handleImportExisting"
      @cancel="handleCancelGenerate"
    />
    <slot v-if="expanded" />
  </div>
</template>
