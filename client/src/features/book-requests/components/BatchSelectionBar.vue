<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import { formatBytes } from '@/lib/formatting'
import type { DownloadClientSummary } from '@bookorbit/types'

const props = defineProps<{
  count: number
  sizeBytes: number
  totalBytes: number | null
  clients: DownloadClientSummary[]
  clientId: number | null
  sending: boolean
}>()
const emit = defineEmits<{
  'update:clientId': [id: number]
  send: []
}>()
const { t } = useI18n()
const capable = computed(() => props.clients.filter((client) => client.fileSelection))
const summary = computed(() => {
  if (props.count === 0) {
    return props.totalBytes === null
      ? t('bookRequests.batch.bar.summaryNoneNoTotal')
      : t('bookRequests.batch.bar.summaryNone', { total: formatBytes(props.totalBytes) })
  }
  return props.totalBytes === null
    ? t('bookRequests.batch.bar.summaryNoTotal', { count: props.count, size: formatBytes(props.sizeBytes) })
    : t('bookRequests.batch.bar.summary', { count: props.count, size: formatBytes(props.sizeBytes), total: formatBytes(props.totalBytes) })
})
const label = computed(() => (props.count === 0 ? t('bookRequests.batch.bar.empty') : t('bookRequests.batch.bar.download', { count: props.count })))
const disabled = computed(() => props.count === 0 || props.sending || props.clientId === null)
function handleClient(event: Event) {
  emit('update:clientId', Number((event.target as HTMLSelectElement).value))
}
function handleSend() {
  emit('send')
}
</script>

<template>
  <div class="mt-3 rounded-lg border border-border bg-card p-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-semibold text-foreground tabular-nums">{{ summary }}</span>
      <select
        :value="clientId ?? ''"
        :aria-label="t('bookRequests.batch.bar.client')"
        class="ml-auto h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        @change="handleClient"
      >
        <option v-for="client in capable" :key="client.id" :value="client.id">{{ client.name }}</option>
      </select>
      <button
        type="button"
        :disabled="disabled"
        class="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        @click="handleSend"
      >
        <Loader2 v-if="sending" class="size-3.5 animate-spin" aria-hidden="true" />
        {{ label }}
      </button>
    </div>
    <p class="mt-2 text-xs text-muted-foreground">{{ t('bookRequests.batch.bar.note') }}</p>
  </div>
</template>
