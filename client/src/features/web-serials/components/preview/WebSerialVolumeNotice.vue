<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Info } from '@lucide/vue'
import type { VolumePackagingNotice } from '../../lib/serialSelection'

const LISTED_CHAPTERS = 50

const props = defineProps<{ notice: VolumePackagingNotice; singleChapters: number }>()

const { t } = useI18n()
const expanded = ref(false)

const outsideCount = computed(() => props.notice.outsideVolumes.length)
const listed = computed(() => props.notice.outsideVolumes.slice(0, LISTED_CHAPTERS))
const hidden = computed(() => outsideCount.value - listed.value.length)
const partialLines = computed(() =>
  props.notice.partialVolumes.map((partial) => t('webSerials.preview.volumePlan.partial', { volume: partial.volume })),
)
const snappedLine = computed(() =>
  props.notice.snappedRange
    ? t('webSerials.preview.volumePlan.snapped', { from: props.notice.snappedRange.fromSequence, to: props.notice.snappedRange.toSequence })
    : null,
)
const visible = computed(() => props.notice.volumes + props.singleChapters > 0)

function handleToggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div v-if="visible" class="space-y-1.5 text-xs text-muted-foreground" data-testid="volume-notice">
    <p class="font-medium text-foreground" data-testid="volume-notice-summary">
      {{ t('webSerials.preview.volumePlan.summary', { volumes: notice.volumes, chapters: singleChapters }) }}
    </p>
    <p v-if="snappedLine" class="flex items-start gap-1.5" data-testid="volume-notice-snapped">
      <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {{ snappedLine }}
    </p>
    <div v-if="outsideCount > 0" data-testid="volume-notice-outside">
      <button
        type="button"
        class="flex items-start gap-1.5 text-start hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :aria-expanded="expanded"
        aria-controls="web-serial-outside-volumes"
        @click="handleToggle"
      >
        <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{{ t('webSerials.preview.volumePlan.outside', { count: outsideCount }) }}</span>
        <ChevronDown class="mt-0.5 size-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-180' : ''" aria-hidden="true" />
      </button>
      <ul v-if="expanded" id="web-serial-outside-volumes" class="mt-1.5 flex flex-wrap gap-1.5 ps-5" data-testid="volume-notice-list">
        <li v-for="unit in listed" :key="unit.key" class="rounded-md border border-border bg-muted px-1.5 py-0.5 tabular-nums">
          {{ unit.sequence }}
        </li>
        <li v-if="hidden > 0" class="px-1.5 py-0.5">{{ t('webSerials.preview.volumePlan.more', { count: hidden }) }}</li>
      </ul>
    </div>
    <p v-for="line in partialLines" :key="line" class="flex items-start gap-1.5" data-testid="volume-notice-partial">
      <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {{ line }}
    </p>
  </div>
</template>
