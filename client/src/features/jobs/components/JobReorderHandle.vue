<script setup lang="ts">
import { GripVertical } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { JobActionKind } from '@bookorbit/types'

const props = defineProps<{ name: string; actions: readonly JobActionKind[]; busy: boolean }>()
const emit = defineEmits<{ act: [action: JobActionKind] }>()
const { t } = useI18n()

function handleKey(event: KeyboardEvent) {
  const action = event.key === 'ArrowUp' ? 'move-up' : event.key === 'ArrowDown' ? 'move-down' : null
  if (!action) return
  event.preventDefault()
  if (!props.busy && props.actions.includes(action)) emit('act', action)
}
</script>

<template>
  <button
    type="button"
    class="grid size-8 shrink-0 touch-none cursor-grab place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing aria-disabled:cursor-default"
    :aria-label="t('jobsArea.reorderHandleOn', { name })"
    :title="t('jobsArea.reorderHandle')"
    :aria-disabled="busy"
    data-job-reorder-handle
    @keydown="handleKey"
  >
    <GripVertical class="size-4" aria-hidden="true" />
  </button>
</template>
