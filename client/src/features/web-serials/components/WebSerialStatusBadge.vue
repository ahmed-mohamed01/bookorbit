<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert } from '@lucide/vue'
import type { WebSerialJobStatus } from '@bookorbit/types'
import { SERIAL_STATUS_TONES, type SerialStatusTone } from '../lib/serialJobStatus'

const props = defineProps<{ status: WebSerialJobStatus }>()

const { t } = useI18n()

const TONES: Record<SerialStatusTone, string> = {
  waiting: 'border-warning/40 bg-warning/10 text-warning',
  progress: 'border-info/40 bg-info/10 text-info',
  done: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  stopped: 'border-border bg-muted text-muted-foreground',
}

const tone = computed(() => SERIAL_STATUS_TONES[props.status] ?? 'stopped')
const label = computed(() => t(`webSerials.status.${props.status}`))
</script>

<template>
  <span
    class="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap"
    :class="TONES[tone]"
  >
    <Check v-if="tone === 'done'" :size="12" :stroke-width="2.5" aria-hidden="true" />
    <TriangleAlert v-else-if="tone === 'failed' || tone === 'warning'" :size="12" aria-hidden="true" />
    <span v-else class="size-1.5 rounded-full bg-current" aria-hidden="true" />
    {{ label }}
  </span>
</template>
