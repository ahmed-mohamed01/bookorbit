<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio } from '@lucide/vue'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainAction, ChainActionId, ChainReadAlongSlotRow } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import ReadAlongBuildOptions from './ReadAlongBuildOptions.vue'
import ReadAlongStepper from './ReadAlongStepper.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'
import SyncChainPlaceholder from './SyncChainPlaceholder.vue'

const props = withDefaults(
  defineProps<{
    row: ChainReadAlongSlotRow
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

const HIDE_LOG: ChainAction['label'] = { key: 'book.detail.editionLink.chain.action.hideLog' }

const noteId = `sync-chain-slot-note-${useId()}`

const showOptions = computed(() => props.expanded && props.row.expandable && props.options !== null)
const secondary = computed(() =>
  props.row.secondary?.id === 'toggleLog' && props.logOpen ? { ...props.row.secondary, label: HIDE_LOG } : props.row.secondary,
)
const showLog = computed(() => props.logOpen && props.row.error)
const showAction = computed(() => props.row.action !== null && !showOptions.value)
const locked = computed(() => props.row.action?.disabled === true)

// The options replace the Generate button, so focus moves into them and back out when they close.
const optionsEl = ref<{ focusGenerate: () => void } | null>(null)
const actionEl = ref<{ $el: HTMLButtonElement } | null>(null)
const rootEl = ref<{ $el: HTMLElement } | null>(null)
watch(showOptions, async (open) => {
  await nextTick()
  if (open) return optionsEl.value?.focusGenerate()
  const action = actionEl.value?.$el
  if (action && !action.disabled) action.focus()
  else rootEl.value?.$el.focus()
})

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
  <SyncChainPlaceholder
    ref="rootEl"
    tabindex="-1"
    view="modify"
    :label="chainText(row.label, t)"
    :note="chainText(row.note, t)"
    :note-id="noteId"
    :data-variant="row.variant"
    data-edition="readAlong"
    data-testid="sync-chain-read-along-slot"
  >
    <template #tile="{ tileClass }">
      <div class="flex items-center justify-center rounded bg-success/15 text-success" :class="tileClass" data-testid="sync-chain-read-along-tile">
        <BookAudio class="size-3.5" />
      </div>
    </template>
    <template #note>
      <SyncChainActionButton v-if="secondary" :action="secondary" variant="link" :disabled="busy" @action="handleAction" />
    </template>
    <template #actions>
      <SyncChainActionButton
        v-if="showAction && row.action"
        ref="actionEl"
        :action="row.action"
        :disabled="busy"
        :aria-describedby="locked ? noteId : undefined"
        @action="handleAction"
      />
      <SyncChainActionButton
        v-if="row.cancel"
        :action="row.cancel"
        :variant="row.variant === 'failed' ? 'outline' : 'cancel'"
        :disabled="busy"
        @action="handleAction"
      />
    </template>

    <ReadAlongStepper v-if="row.job" :stage="row.job.stage" :remote-progress="row.job.remoteProgress" :failed="row.job.failed" />
    <p v-if="showLog" class="ps-[46px] pe-1 text-xs break-words text-muted-foreground" data-testid="sync-chain-slot-log">{{ row.error }}</p>
    <ReadAlongBuildOptions
      v-if="showOptions && options"
      ref="optionsEl"
      :keep-remote-copy="options.keepRemoteCopy"
      :reclaimable="options.reclaimable"
      :target-library-name="options.targetLibraryName"
      :target-libraries="options.targetLibraries"
      :chosen-target-library-id="options.chosenTargetLibraryId"
      :existing-match="options.existingMatch"
      :busy="options.busy || busy"
      @update:keep-remote-copy="handleKeepRemoteCopy"
      @update:target-library-id="handleTargetLibrary"
      @generate="handleGenerate"
      @import-existing="handleImportExisting"
      @cancel="handleCancelGenerate"
    />
  </SyncChainPlaceholder>
</template>
