<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { BookOpen, Loader2, RefreshCw } from '@lucide/vue'
import type { WebSerialJobItem, WebSerialJobItemStatus } from '@bookorbit/types'
import { Button } from '@/components/ui/button'

const props = defineProps<{ item: WebSerialJobItem; retrying: boolean; canRetry: boolean }>()
const emit = defineEmits<{ retry: [item: WebSerialJobItem] }>()

const { t } = useI18n()

const TONES: Record<WebSerialJobItemStatus, string> = {
  pending: 'border-border bg-muted text-muted-foreground',
  fetching: 'border-info/40 bg-info/10 text-info',
  importing: 'border-info/40 bg-info/10 text-info',
  imported: 'border-success/40 bg-success/10 text-success',
  skipped: 'border-border bg-muted text-muted-foreground',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
}

const failed = computed(() => props.item.status === 'failed')
const bookTarget = computed(() =>
  props.item.status === 'imported' && props.item.bookId ? { name: 'book-detail', params: { bookId: props.item.bookId } } : null,
)

function handleRetry() {
  emit('retry', props.item)
}
</script>

<template>
  <div class="flex min-h-9 items-center gap-2 px-2 py-1 text-xs">
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium text-foreground">{{ item.label }}</p>
      <p v-if="failed && item.error" class="truncate text-destructive" :title="item.error">{{ item.error }}</p>
    </div>
    <span class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap" :class="TONES[item.status]">
      {{ t(`webSerials.queue.item.${item.status}`) }}
    </span>
    <Button
      v-if="failed && canRetry"
      variant="outline"
      size="sm"
      class="h-6 shrink-0 gap-1 px-2 text-xs"
      :disabled="retrying"
      :aria-label="t('webSerials.queue.item.retryLabel', { label: item.label })"
      @click="handleRetry"
    >
      <Loader2 v-if="retrying" class="animate-spin" aria-hidden="true" />
      <RefreshCw v-else :size="12" aria-hidden="true" />
      {{ t('webSerials.queue.retry') }}
    </Button>
    <RouterLink
      v-if="bookTarget"
      :to="bookTarget"
      :aria-label="t('webSerials.queue.item.openLabel', { label: item.label })"
      class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <BookOpen :size="12" aria-hidden="true" />
      {{ t('webSerials.queue.open') }}
    </RouterLink>
  </div>
</template>
