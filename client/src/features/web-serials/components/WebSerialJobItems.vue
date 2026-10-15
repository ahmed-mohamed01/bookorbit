<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { Loader2 } from '@lucide/vue'
import type { WebSerialJobItem } from '@bookorbit/types'
import type { SerialJobDetailState } from '../composables/useWebSerialQueue'
import WebSerialJobItemRow from './WebSerialJobItemRow.vue'

const VIRTUALIZE_ABOVE = 100
const ROW_HEIGHT = 40
const VIEWPORT_HEIGHT = 320

const props = defineProps<{ state: SerialJobDetailState | undefined; jobId: number; canRetry: boolean }>()
const emit = defineEmits<{ retry: [item: WebSerialJobItem] }>()

const { t } = useI18n()
const items = computed(() => props.state?.items ?? [])
const virtual = computed(() => items.value.length > VIRTUALIZE_ABOVE)
const scrollEl = ref<HTMLElement | null>(null)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: virtual.value ? items.value.length : 0,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 0, height: VIEWPORT_HEIGHT },
  })),
)

function isRetrying(item: WebSerialJobItem): boolean {
  return props.state?.retryingItemIds.has(item.id) ?? false
}

function handleRetry(item: WebSerialJobItem) {
  emit('retry', item)
}
</script>

<template>
  <div :id="`web-serial-job-${jobId}-items`" class="mt-3 rounded-md border border-border bg-muted/30">
    <p v-if="!state || (state.loading && items.length === 0)" class="flex items-center gap-2 p-3 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      {{ t('webSerials.queue.details.loading') }}
    </p>
    <p v-else-if="state.error && items.length === 0" role="alert" class="p-3 text-xs text-destructive">{{ state.error }}</p>
    <p v-else-if="items.length === 0" class="p-3 text-xs text-muted-foreground">{{ t('webSerials.queue.details.empty') }}</p>
    <div v-else-if="virtual" ref="scrollEl" class="overflow-y-auto" :style="{ maxHeight: `${VIEWPORT_HEIGHT}px` }" data-testid="virtual-items">
      <ul class="relative w-full" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <li
          v-for="row in virtualizer.getVirtualItems()"
          :key="items[row.index]?.id ?? row.index"
          class="absolute inset-x-0 border-b border-border/60 last:border-b-0"
          :style="{ height: `${ROW_HEIGHT}px`, transform: `translateY(${row.start}px)` }"
        >
          <WebSerialJobItemRow
            v-if="items[row.index]"
            :item="items[row.index]!"
            :retrying="isRetrying(items[row.index]!)"
            :can-retry="canRetry"
            @retry="handleRetry"
          />
        </li>
      </ul>
    </div>
    <ul v-else class="divide-y divide-border/60">
      <li v-for="item in items" :key="item.id">
        <WebSerialJobItemRow :item="item" :retrying="isRetrying(item)" :can-retry="canRetry" @retry="handleRetry" />
      </li>
    </ul>
  </div>
</template>
