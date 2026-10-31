<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio } from '@lucide/vue'
import type { ChainActionId, ChainReadAloudSlotRow } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import SyncChainActionButton from './SyncChainActionButton.vue'
import SyncChainPlaceholder from './SyncChainPlaceholder.vue'
import SyncChainReadAloudStepper from './SyncChainReadAloudStepper.vue'

const props = withDefaults(defineProps<{ row: ChainReadAloudSlotRow; busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ action: [id: ChainActionId, rowKey: string] }>()

const { t } = useI18n()

const noteId = `sync-chain-slot-note-${useId()}`

const locked = computed(() => props.row.action?.disabled === true)

function isPending(id: ChainActionId | undefined): boolean {
  return id !== undefined && props.row.pending === id
}

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}
</script>

<template>
  <SyncChainPlaceholder
    view="modify"
    :label="chainText(row.label, t)"
    :note="chainText(row.note, t)"
    :note-id="noteId"
    :data-variant="row.variant"
    data-edition="readAlong"
    data-testid="sync-chain-read-aloud-slot"
  >
    <template #tile="{ tileClass }">
      <div class="flex items-center justify-center rounded bg-success/15 text-success" :class="tileClass" data-testid="sync-chain-read-aloud-tile">
        <BookAudio class="size-3.5" />
      </div>
    </template>
    <template #actions>
      <SyncChainActionButton
        v-if="row.action"
        :action="row.action"
        :busy="isPending(row.action.id)"
        :disabled="busy"
        :aria-describedby="locked ? noteId : undefined"
        @action="handleAction"
      />
      <SyncChainActionButton v-if="row.secondary" :action="row.secondary" variant="link" :disabled="busy" @action="handleAction" />
      <SyncChainActionButton
        v-if="row.cancel"
        :action="row.cancel"
        variant="cancel"
        :busy="isPending(row.cancel.id)"
        :disabled="busy"
        @action="handleAction"
      />
    </template>

    <SyncChainReadAloudStepper v-if="row.progress" :stage="row.progress.stage" :percent="row.progress.percent" />
  </SyncChainPlaceholder>
</template>
