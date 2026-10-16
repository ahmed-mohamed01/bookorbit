<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Search } from '@lucide/vue'
import { formatPercent } from '@/i18n/formatters'
import { formatBytes } from '@/lib/formatting'
import { relativeTimestamp } from '@/lib/relative-time'
import type { MonitoredFormat } from '@bookorbit/types'
import { SLOT_REQUEST_ICONS, type SlotRequestKind } from '../lib/slot-request'
import MonitoredSlotRequest from './MonitoredSlotRequest.vue'

/** The divided footer of a format card: library facts on the left, the action row on the right. */
const props = withDefaults(
  defineProps<{
    format: MonitoredFormat
    owned: boolean
    /** When the book joined the library; null before the page reports it. */
    availableSince: { date: string } | null
    /** An owned format's release date, stated under when it joined the library. */
    releasedLabel?: string | null
    releasesOpen: boolean
    /** Offers the Search actions; a viewer only reads. */
    canEdit: boolean
    /** Offers the disk Check; only a manager may run one. */
    canManage: boolean
    /** When the author's files were last checked; null before the first check. */
    checkedAt?: string | null
    checking?: boolean
    requestKind: SlotRequestKind | null
    requestRoute: { name: string; params: { id: number } } | null
    canRequest: boolean
    busy?: boolean
    hint?: string | null
    releasesBlockedHint?: string | null
    releasesToggleLabel: string
    /** The live transfer behind a download, preferring the socket tick over the persisted row. */
    download: { percent: number; downloadedBytes: number | null; totalBytes: number | null } | null
  }>(),
  { releasesBlockedHint: null },
)

const emit = defineEmits<{
  check: []
  'toggle-releases': [format: MonitoredFormat]
  request: [format: MonitoredFormat]
}>()

const { t } = useI18n()

/** The request states the footer's left column names in words; a download draws its progress instead. */
const FOOTER_STATE_KINDS: ReadonlySet<SlotRequestKind> = new Set(['requested', 'searching', 'importing', 'review'])
const movingKind = computed(() => (props.requestKind && FOOTER_STATE_KINDS.has(props.requestKind) ? props.requestKind : null))
const downloading = computed(() => props.requestKind === 'downloading')
const checkedLabel = computed(() => (props.checkedAt ? t('monitored.panel.checkedAgo', { when: relativeTimestamp(props.checkedAt) }) : null))

/** What the left column reads: the running state, or when the disk was last checked. */
const stateLine = computed(() => {
  if (downloading.value) {
    const label = props.download
      ? t('monitored.slot.downloadingPercent', { percent: formatPercent(props.download.percent / 100) })
      : t('monitored.slot.request.downloading')
    const transferred =
      props.download && props.download.totalBytes != null && props.download.downloadedBytes != null
        ? t('monitored.slot.transferred', { done: formatBytes(props.download.downloadedBytes), total: formatBytes(props.download.totalBytes) })
        : null
    return { label, icon: RefreshCw, spinning: true, tone: 'text-primary', detail: transferred }
  }
  if (movingKind.value) {
    const tone = movingKind.value === 'importing' ? 'text-[var(--pill-info)]' : 'text-[var(--pill-warning)]'
    return {
      label: t(`monitored.slot.request.${movingKind.value}`),
      icon: SLOT_REQUEST_ICONS[movingKind.value],
      spinning: false,
      tone,
      detail: checkedLabel.value,
    }
  }
  return { label: checkedLabel.value, icon: null, spinning: false, tone: 'text-foreground', detail: t('monitored.slot.noFileOnDisk') }
})

const showCheck = computed(() => !downloading.value)

const ownedReleasesLabel = computed(() => (props.releasesOpen ? t('monitored.slot.hideReleases') : t('monitored.slot.searchReplacement')))
const searchLabel = computed(() => (props.releasesOpen ? t('monitored.slot.hideReleases') : t('monitored.slot.releasesButton')))

function handleCheck() {
  emit('check')
}

function handleToggleReleases() {
  emit('toggle-releases', props.format)
}

function handleRequest(format: MonitoredFormat) {
  emit('request', format)
}
</script>

<template>
  <div
    v-if="!owned || canEdit || availableSince || releasedLabel"
    class="flex flex-col gap-2 border-t border-border px-2.5 ps-3 py-2"
    data-testid="slot-footer"
  >
    <div v-if="owned" class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div class="min-w-0 flex-1">
        <i18n-t v-if="availableSince" keypath="monitored.slot.availableSince" tag="p" class="text-[13px] leading-snug font-medium text-foreground">
          <template #date>{{ availableSince.date }}</template>
        </i18n-t>
        <p v-if="releasedLabel" class="text-xs text-muted-foreground" data-testid="footer-released">{{ releasedLabel }}</p>
      </div>
      <button
        v-if="canEdit"
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] border border-border px-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
        :aria-expanded="releasesOpen"
        :aria-label="ownedReleasesLabel"
        data-testid="owned-releases-toggle"
        @click="handleToggleReleases"
      >
        <Search :size="13" aria-hidden="true" />
        {{ ownedReleasesLabel }}
      </button>
    </div>
    <template v-else>
      <div class="flex items-center gap-3">
        <p class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-[13px]">
          <span v-if="stateLine.label" class="inline-flex items-center gap-1.5 font-medium" :class="stateLine.tone">
            <component
              :is="stateLine.icon"
              v-if="stateLine.icon"
              :size="13"
              :class="stateLine.spinning ? 'motion-safe:animate-spin' : undefined"
              aria-hidden="true"
            />
            {{ stateLine.label }}
          </span>
          <span v-if="stateLine.detail" class="text-xs text-muted-foreground tabular-nums"
            ><span v-if="stateLine.label" aria-hidden="true">&middot; </span>{{ stateLine.detail }}</span
          >
        </p>
        <div
          v-if="downloading && download"
          class="h-1 w-18 shrink-0 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          :aria-valuenow="download.percent"
          aria-valuemin="0"
          aria-valuemax="100"
          data-testid="slot-progress"
        >
          <div class="h-full rounded-full bg-primary" :style="{ width: `${download.percent}%` }" />
        </div>
        <button
          v-else-if="canManage && showCheck"
          type="button"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
          :disabled="checking"
          :aria-label="t('monitored.slot.check')"
          data-testid="check-library"
          @click="handleCheck"
        >
          <RefreshCw :size="13" :class="checking ? 'motion-safe:animate-spin' : undefined" aria-hidden="true" />
          {{ t('monitored.slot.check') }}
        </button>
      </div>
      <div v-if="canEdit" class="flex gap-2">
        <button
          type="button"
          class="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[7px] border border-border px-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
          :class="releasesOpen ? 'border-transparent bg-muted' : undefined"
          :disabled="releasesBlockedHint !== null"
          :aria-expanded="releasesOpen"
          :aria-label="releasesToggleLabel"
          :title="releasesBlockedHint ?? releasesToggleLabel"
          data-testid="releases-toggle"
          @click="handleToggleReleases"
        >
          <Search :size="13" aria-hidden="true" />
          {{ searchLabel }}
        </button>
        <div class="min-w-0 flex-1">
          <MonitoredSlotRequest
            :format="format"
            :kind="requestKind"
            :request-route="requestRoute"
            :can-request="canRequest"
            :busy="busy"
            :hint="hint"
            @request="handleRequest"
          />
        </div>
      </div>
    </template>
  </div>
</template>
