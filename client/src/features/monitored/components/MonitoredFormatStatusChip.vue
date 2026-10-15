<script setup lang="ts">
import { computed } from 'vue'
import { BookOpen, Headphones } from '@lucide/vue'
import type { MonitorMode, MonitoredFormat, MonitoredWork } from '@bookorbit/types'
import { FORMAT_STATUS_TONES, type MonitoredFormatStatus } from '../lib/format-status'
import { useFormatStatusText } from '../composables/useFormatStatusText'

/** One format of a work in a compact list: its icon, a word for its state, and the full sentence on hover. */
const props = defineProps<{
  work: MonitoredWork
  format: MonitoredFormat
  status: MonitoredFormatStatus
  mode?: MonitorMode | null
}>()

const { describe, sentence } = useFormatStatusText()

const tone = computed(() => FORMAT_STATUS_TONES[props.status])
const short = computed(() => describe(props.work, props.format, props.status).short)
const full = computed(() => sentence(props.work, props.format, props.status, { mode: props.mode }))
</script>

<template>
  <span
    class="inline-flex h-5 max-w-full min-w-0 shrink items-center gap-1 rounded-full border px-1.5 text-[10px] font-semibold leading-none whitespace-nowrap"
    :class="tone.chip"
    :title="full"
    :data-status="status"
  >
    <BookOpen v-if="format === 'ebook'" :size="10" class="shrink-0" aria-hidden="true" />
    <Headphones v-else :size="10" class="shrink-0" aria-hidden="true" />
    <span class="truncate" aria-hidden="true">{{ short }}</span>
    <span class="sr-only">{{ full }}</span>
  </span>
</template>
