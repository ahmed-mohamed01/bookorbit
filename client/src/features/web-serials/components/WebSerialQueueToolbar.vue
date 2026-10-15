<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, Pause, Play, Trash2 } from '@lucide/vue'
import type { WebSerialJobScope } from '@bookorbit/types'
import { Button } from '@/components/ui/button'

defineProps<{
  isAdmin: boolean
  scope: WebSerialJobScope
  queuePaused: boolean
  finishedCount: number
  clearing: boolean
  queueBusy: boolean
}>()
const emit = defineEmits<{ 'update:scope': [scope: WebSerialJobScope]; clear: []; togglePause: [] }>()

const { t } = useI18n()
const SCOPES: WebSerialJobScope[] = ['mine', 'all']

function handleScope(scope: WebSerialJobScope) {
  emit('update:scope', scope)
}

function handleClear() {
  emit('clear')
}

function handleTogglePause() {
  emit('togglePause')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div
      v-if="isAdmin"
      role="group"
      :aria-label="t('webSerials.queue.toolbar.scopeLabel')"
      class="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
    >
      <button
        v-for="option in SCOPES"
        :key="option"
        type="button"
        :aria-pressed="scope === option"
        class="h-7 rounded-[5px] px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        :class="scope === option ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
        @click="handleScope(option)"
      >
        {{ t(`webSerials.queue.toolbar.scope.${option}`) }}
      </button>
    </div>
    <div class="ms-auto flex flex-wrap items-center gap-2">
      <Button v-if="isAdmin" variant="outline" size="sm" :disabled="queueBusy" @click="handleTogglePause">
        <Loader2 v-if="queueBusy" class="animate-spin" aria-hidden="true" />
        <Play v-else-if="queuePaused" :size="14" aria-hidden="true" />
        <Pause v-else :size="14" aria-hidden="true" />
        {{ t(queuePaused ? 'webSerials.queue.toolbar.resumeQueue' : 'webSerials.queue.toolbar.pauseQueue') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="finishedCount === 0 || clearing" @click="handleClear">
        <Loader2 v-if="clearing" class="animate-spin" aria-hidden="true" />
        <Trash2 v-else :size="14" aria-hidden="true" />
        {{ t('webSerials.queue.toolbar.clearFinished') }}
      </Button>
    </div>
  </div>
</template>
