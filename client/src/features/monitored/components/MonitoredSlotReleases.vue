<script setup lang="ts">
import { computed, ref } from 'vue'
import { Loader2, RefreshCw, UserCheck, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat, ReleaseCandidateItem } from '@bookorbit/types'
import { relativeTimestamp } from '@/lib/relative-time'
import type { useMonitoredReleases } from '../composables/useMonitoredReleases'
import ReleaseResultRow from './ReleaseResultRow.vue'

const PREVIEW_COUNT = 3

/** The release search of one format slot, drawn inside the slot: the best few results, the rest on demand. */
const props = defineProps<{
  format: MonitoredFormat
  source: ReturnType<typeof useMonitoredReleases>
  canSearch: boolean
  /** A request that waits for an owner to approve it may be sent instead of grabbing. */
  canAskApproval: boolean
  closable?: boolean
}>()
const emit = defineEmits<{
  grab: [format: MonitoredFormat, release: ReleaseCandidateItem]
  'ask-approval': [format: MonitoredFormat]
  close: [format: MonitoredFormat]
}>()

const { t } = useI18n()
const showAll = ref(false)

const releases = computed(() => props.source.releases.value)
const visible = computed(() => (showAll.value ? releases.value : releases.value.slice(0, PREVIEW_COUNT)))
const showFooter = computed(() => !props.source.loading.value && (releases.value.length > 0 || props.canAskApproval))
const hiddenCount = computed(() => Math.max(0, releases.value.length - PREVIEW_COUNT))

const heading = computed(() => {
  const parts = [t('monitored.slot.releases.title')]
  if (props.source.searched.value && !props.source.error.value) {
    parts.push(t('monitored.slot.releases.indexers', { count: props.source.indexers.value.length }))
    const at = props.source.searchedAt.value
    if (at) parts.push(relativeTimestamp(at))
  }
  return parts.join(' · ')
})

function releaseKey(release: ReleaseCandidateItem): string {
  return `${release.indexerId}:${release.guid}`
}

function handleSearch() {
  showAll.value = false
  void props.source.search()
}

function handleShowAll() {
  showAll.value = true
}

function handleGrab(release: ReleaseCandidateItem) {
  emit('grab', props.format, release)
}

function handleAskApproval() {
  emit('ask-approval', props.format)
}

function handleClose() {
  emit('close', props.format)
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs font-medium text-muted-foreground" data-testid="releases-heading">{{ heading }}</p>
      <div class="flex items-center gap-0.5">
        <button
          v-if="canSearch"
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-11"
          :disabled="source.loading.value"
          :aria-label="t('monitored.panel.searchReleases')"
          data-testid="releases-search"
          @click="handleSearch"
        >
          <RefreshCw :size="13" aria-hidden="true" />
        </button>
        <button
          v-if="closable"
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [@media(pointer:coarse)]:size-11"
          :aria-label="t('monitored.slot.releases.close')"
          @click="handleClose"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>

    <p v-if="source.grabError.value && !source.error.value" role="alert" class="mt-2 text-xs text-destructive" data-testid="grab-error">
      {{ source.grabError.value }}
    </p>
    <p v-if="source.loading.value" role="status" class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      {{ t('monitored.panel.searching') }}
    </p>
    <p v-else-if="source.error.value" role="alert" class="mt-2 text-xs text-destructive">{{ source.error.value }}</p>
    <ul v-else-if="releases.length" class="mt-2 flex flex-col gap-1">
      <ReleaseResultRow
        v-for="(release, index) in visible"
        :key="releaseKey(release)"
        compact
        :best="index === 0"
        :release="release"
        :delivery="source.deliveryFor(release)"
        :busy="source.loading.value || source.isGrabbing(release)"
        :grabbed="source.isGrabbed(release)"
        @grab="handleGrab"
      />
    </ul>
    <p v-else-if="source.searched.value" class="mt-2 text-xs text-muted-foreground">{{ t('monitored.panel.noReleases') }}</p>

    <div v-if="showFooter" class="mt-2 flex flex-wrap items-center justify-between gap-2">
      <button
        v-if="!showAll && hiddenCount > 0"
        type="button"
        class="text-xs font-medium text-foreground underline-offset-2 hover:underline [@media(pointer:coarse)]:min-h-11"
        data-testid="releases-show-all"
        @click="handleShowAll"
      >
        {{ t('monitored.slot.releases.showAll', { count: releases.length }) }}
      </button>
      <span v-else />
      <button
        v-if="canAskApproval"
        type="button"
        class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11"
        data-testid="ask-approval"
        @click="handleAskApproval"
      >
        <UserCheck :size="13" aria-hidden="true" />
        {{ t('monitored.slot.releases.askApproval') }}
      </button>
    </div>
  </div>
</template>
