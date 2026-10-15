<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import type { WebSerialKind, WebSerialUnit } from '@bookorbit/types'
import { formatDate } from '@/i18n/formatters'

const props = defineProps<{
  unit: WebSerialUnit
  kind: WebSerialKind
  imported: boolean
  /** Committed span membership. */
  selected: boolean
  /** Inside the live preview between the anchor and the hovered row. */
  previewed: boolean
  /** The first tap of a range that is still waiting for its end. */
  anchor: boolean
  mark: 'start' | 'end' | null
  choosing: boolean
  /** Undefined hides the chip; null means the volume is not known. */
  volume?: string | null
}>()

const emit = defineEmits<{ select: [sequence: string]; peek: [sequence: string] }>()
const { t } = useI18n()

const secondary = computed(() => {
  if (props.kind === 'novel') return t('webSerials.preview.unitChapters', { count: props.unit.chapterCount })
  if (!props.unit.publishedAt) return null
  const date = new Date(props.unit.publishedAt)
  if (Number.isNaN(date.getTime())) return null
  return formatDate(date, { year: 'numeric', month: 'short', day: 'numeric' })
})

const tint = computed(() => {
  if (props.anchor) return 'bg-primary/15'
  if (props.selected) return 'bg-primary/12'
  if (props.previewed) return 'bg-primary/10'
  return props.choosing ? 'hover:bg-muted' : ''
})

const marked = computed(() => props.anchor || props.selected)

function handleSelect() {
  if (props.choosing) emit('select', props.unit.sequence)
}

function handlePeek() {
  if (props.choosing) emit('peek', props.unit.sequence)
}
</script>

<template>
  <button
    type="button"
    data-unit-row
    class="flex h-10 w-full items-center gap-2 border-s-[3px] px-3 text-start transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
    :class="[tint, mark ? 'border-primary' : 'border-transparent']"
    :aria-pressed="choosing ? marked : undefined"
    :aria-disabled="!choosing"
    :tabindex="choosing ? undefined : -1"
    @click="handleSelect"
    @pointerenter="handlePeek"
    @focus="handlePeek"
  >
    <span
      v-if="choosing"
      class="flex size-4 shrink-0 items-center justify-center rounded-full border"
      :class="
        marked ? 'border-primary bg-primary text-primary-foreground' : previewed ? 'border-primary/60 text-primary' : 'border-border bg-background'
      "
      aria-hidden="true"
    >
      <Check v-if="marked || previewed" :size="11" :stroke-width="3" />
    </span>
    <span class="min-w-0 flex-1 truncate text-sm text-foreground" :class="marked ? 'font-semibold' : 'font-medium'">{{ unit.label }}</span>
    <span v-if="mark" class="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground" data-testid="unit-mark">
      {{ mark === 'start' ? t('webSerials.preview.markStart') : t('webSerials.preview.markEnd') }}
    </span>
    <span
      v-if="volume !== undefined"
      class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
      data-testid="unit-volume"
    >
      {{ volume === null ? t('webSerials.preview.noVolume') : t('webSerials.preview.volumeChip', { volume }) }}
    </span>
    <span v-if="secondary" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ secondary }}</span>
    <span v-if="imported" class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
      <Check :size="13" :stroke-width="2.5" aria-hidden="true" />
      {{ t('webSerials.preview.inLibrary') }}
    </span>
  </button>
</template>
