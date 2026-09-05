<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink } from '@lucide/vue'
import { Skeleton } from '@/components/ui/skeleton'
import RequestDownloadProgress from '@/features/book-requests/components/RequestDownloadProgress.vue'
import RequestPipeline from '@/features/book-requests/components/RequestPipeline.vue'
import RequestStatusBadge from '@/features/book-requests/components/RequestStatusBadge.vue'
import type { BookRequestDetailError } from '@/features/book-requests/composables/useBookRequestDetail'
import { useMonitoredRequestProgress } from '../composables/useMonitoredRequestProgress'

const props = defineProps<{ requestId: number }>()
const emit = defineEmits<{ filed: [requestId: number] }>()

const { t } = useI18n()

/** The moment the download is in the library: what this work owns has just changed behind the page. */
function handleFiled(requestId: number) {
  emit('filed', requestId)
}

const { request, error, live, status, settled } = useMonitoredRequestProgress(toRef(props, 'requestId'), { onFiled: handleFiled })

const ERROR_KEYS: Record<BookRequestDetailError, string> = {
  notFound: 'monitored.panel.progress.notFound',
  forbidden: 'monitored.panel.progress.forbidden',
  loadFailed: 'monitored.panel.progress.loadFailed',
}

const errorText = computed(() => (error.value ? t(ERROR_KEYS[error.value]) : null))

const requestRoute = computed(() => ({ name: 'book-request-detail', params: { id: props.requestId } }))

/**
 * A settled request has nowhere left to go, so the stepper is the status badge again in five times
 * the room. The transfer line stays either way: where the file came from is the one thing still
 * worth reading once the download is over.
 */
const showPipeline = computed(() => request.value !== null && !settled.value)
</script>

<template>
  <section class="rounded-xl border border-border bg-muted/30 p-3" :aria-label="t('monitored.panel.progress.label')">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <RequestStatusBadge v-if="status" :status="status" />
      <Skeleton v-else class="h-[22px] w-24 rounded-full" />
      <RouterLink
        :to="requestRoute"
        class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline motion-reduce:transition-none"
      >
        {{ t('monitored.panel.progress.openInRequests') }}
        <ExternalLink :size="12" aria-hidden="true" />
      </RouterLink>
    </div>

    <p v-if="errorText" role="alert" class="mt-3 text-xs text-destructive">{{ errorText }}</p>

    <template v-else-if="request">
      <div v-if="showPipeline" class="mt-3">
        <h4 class="mb-2.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ t('bookRequests.pipeline.label') }}</h4>
        <RequestPipeline :request="request" :live="live" />
      </div>

      <div v-if="request.download" class="mt-3">
        <h4 class="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ t('bookRequests.detail.transfer') }}</h4>
        <RequestDownloadProgress :download="request.download" :live="live" />
      </div>

      <p v-else-if="!showPipeline" class="mt-2 text-xs text-muted-foreground">{{ t('monitored.panel.progress.noTransfer') }}</p>
    </template>

    <div v-else class="mt-3 space-y-2">
      <Skeleton class="h-3.5 w-full rounded-full" />
      <Skeleton class="h-3 w-2/3 rounded-full" />
    </div>
  </section>
</template>
