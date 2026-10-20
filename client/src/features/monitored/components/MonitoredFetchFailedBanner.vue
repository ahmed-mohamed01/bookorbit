<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFetchStatus } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { relativeTimestamp } from '@/lib/relative-time'
import { fetchStatusCopy } from '../lib/fetch-status-copy'
const props = defineProps<{ status: MonitoredFetchStatus; hasCatalog: boolean; lastRefreshedAt: string | null }>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
const now = ref(new Date())
const timer = setInterval(() => {
  now.value = new Date()
}, 30_000)
onUnmounted(() => clearInterval(timer))
const copy = computed(() => fetchStatusCopy(props.status, now.value, props.hasCatalog))
function handleRetry(): void {
  emit('retry')
}
</script>
<template>
  <div
    v-if="status.state === 'failed' && copy"
    role="status"
    class="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm"
  >
    <TriangleAlert :size="16" class="shrink-0 text-warning" aria-hidden="true" />
    <div class="min-w-56 flex-1">
      <p class="font-medium text-foreground">{{ t(copy.titleKey) }}</p>
      <p class="text-muted-foreground">{{ t(copy.actionKey, copy.actionParams ?? {}) }}</p>
      <p v-if="status.errorAt" class="text-muted-foreground">{{ t('monitored.fetch.failedAt', { when: relativeTimestamp(status.errorAt) }) }}</p>
      <p v-if="hasCatalog && lastRefreshedAt" class="text-muted-foreground">
        {{ t('monitored.fetch.showingFrom', { when: relativeTimestamp(lastRefreshedAt) }) }}
      </p>
    </div>
    <slot v-if="status.errorKind !== 'author_gone'" name="retry">
      <Button variant="outline" size="sm" @click="handleRetry">{{ t('monitored.fetch.retryNow') }}</Button>
    </slot>
  </div>
</template>
