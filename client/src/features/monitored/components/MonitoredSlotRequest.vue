<script setup lang="ts">
import { computed, type Component } from 'vue'
import { AlertCircle, Clock, Download, Loader2, Package, RotateCw, Search, WandSparkles } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat } from '@bookorbit/types'
import type { SlotRequestKind } from '../lib/slot-request'

/**
 * The request button of a format slot. With no request, or after a failed one, it sends a
 * request; while a request is moving it is a link to it.
 */
const props = defineProps<{
  format: MonitoredFormat
  /** What the format's request is doing, or null when there is none to follow. */
  kind: SlotRequestKind | null
  /** Where the request can be followed; null when this viewer has no request to open. */
  requestRoute: { name: string; params: { id: number } } | null
  /** A new request may be sent from here. */
  canRequest: boolean
  busy?: boolean
  hint?: string | null
}>()
const emit = defineEmits<{
  request: [format: MonitoredFormat]
}>()

const { t } = useI18n()
const formatLabel = computed(() => t(`monitored.formats.${props.format}`))
const formatName = computed(() => formatLabel.value.toLowerCase())
const requestPrefix = computed(() => t('monitored.slot.requestStatus', { format: formatLabel.value }))

const FOLLOW_ICONS: Record<SlotRequestKind, Component> = {
  requested: Clock,
  searching: Search,
  downloading: Download,
  importing: Package,
  review: AlertCircle,
  failed: RotateCw,
}

const FOLLOW_TONES: Record<SlotRequestKind, string> = {
  requested: 'border-border text-muted-foreground',
  searching: 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]',
  downloading: 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]',
  importing: 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]',
  review: 'border-[var(--pill-warning)]/40 bg-[var(--pill-warning)]/10 text-[var(--pill-warning)]',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
}

const split = computed(() => props.canRequest && (props.kind === null || props.kind === 'failed'))
const following = computed(() => (split.value ? null : props.kind))
const failed = computed(() => props.kind === 'failed')

const baseClass =
  'inline-flex h-7 shrink-0 items-center gap-1 border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 [@media(pointer:coarse)]:min-h-11'

function handleRequest() {
  emit('request', props.format)
}
</script>

<template>
  <button
    v-if="split"
    type="button"
    :class="[
      baseClass,
      'rounded-md',
      failed ? 'border-destructive/50 text-destructive hover:bg-destructive/10' : 'border-primary/50 text-primary hover:bg-primary/10',
    ]"
    :disabled="busy"
    :aria-label="failed ? t('monitored.slot.retryFormat', { format: formatName }) : t('monitored.panel.requestFormat', { format: formatName })"
    :title="hint ?? undefined"
    :data-request-kind="kind ?? 'none'"
    @click="handleRequest"
  >
    <Loader2 v-if="busy" :size="13" class="motion-safe:animate-spin" aria-hidden="true" />
    <RotateCw v-else-if="failed" :size="13" aria-hidden="true" />
    <WandSparkles v-else :size="13" aria-hidden="true" />
    {{ failed ? t('monitored.panel.retry') : t('monitored.panel.request') }}
  </button>
  <RouterLink
    v-else-if="following && requestRoute"
    :to="requestRoute"
    :class="[baseClass, 'rounded-md', FOLLOW_TONES[following]]"
    :data-request-kind="following"
  >
    <component :is="FOLLOW_ICONS[following]" :size="13" aria-hidden="true" />
    <span class="sr-only">{{ requestPrefix }}</span>
    {{ t(`monitored.slot.request.${following}`) }}
  </RouterLink>
  <span v-else-if="following" :class="[baseClass, 'rounded-md', FOLLOW_TONES[following]]" :data-request-kind="following">
    <component :is="FOLLOW_ICONS[following]" :size="13" aria-hidden="true" />
    <span class="sr-only">{{ requestPrefix }}</span>
    {{ t(`monitored.slot.request.${following}`) }}
  </span>
</template>
