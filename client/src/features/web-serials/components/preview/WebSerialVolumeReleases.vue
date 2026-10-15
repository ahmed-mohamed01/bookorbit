<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, Loader2 } from '@lucide/vue'
import type { ReleaseCandidateItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/i18n/formatters'
import { formatBytes } from '@/lib/formatting'
import type { VolumeReleases } from '../../composables/useWebSerialPublishedVolumes'

const props = defineProps<{
  volume: number
  results: VolumeReleases
  /** The guid of the release being sent, if any. Every Grab waits while one is in flight. */
  grabbing: string | null
}>()

const emit = defineEmits<{ grab: [release: ReleaseCandidateItem] }>()

const { t } = useI18n()

const truncated = computed(() => props.results.total > props.results.releases.length)
const topLine = computed(() =>
  t('webSerials.preview.published.releasesTop', {
    shown: formatNumber(props.results.releases.length),
    total: formatNumber(props.results.total),
  }),
)

function details(release: ReleaseCandidateItem): string {
  const parts = [release.indexerName]
  if (release.sizeBytes !== null) parts.push(formatBytes(release.sizeBytes))
  if (release.seeders !== null) parts.push(t('webSerials.preview.published.seeders', { count: release.seeders }))
  return parts.join(' · ')
}

function handleGrab(release: ReleaseCandidateItem) {
  emit('grab', release)
}
</script>

<template>
  <div
    class="mt-2 rounded-md border border-border bg-muted/40 p-2"
    role="region"
    :aria-label="t('webSerials.preview.published.releasesLabel', { volume })"
  >
    <p v-if="results.state === 'loading'" class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      {{ t('webSerials.preview.published.searching') }}
    </p>
    <p v-else-if="results.state === 'error'" role="alert" class="text-xs text-destructive">{{ results.error }}</p>
    <p v-else-if="results.releases.length === 0" class="text-xs text-muted-foreground">{{ t('webSerials.preview.published.noReleases') }}</p>
    <template v-else>
      <ul class="divide-y divide-border">
        <li
          v-for="release in results.releases"
          :key="`${release.indexerId}:${release.guid}`"
          class="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-center"
          data-testid="published-release"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-foreground" :title="release.title">{{ release.title }}</p>
            <p class="text-xs text-muted-foreground tabular-nums">{{ details(release) }}</p>
          </div>
          <Button
            size="sm"
            class="self-end sm:self-auto"
            :disabled="grabbing !== null"
            :aria-label="t('webSerials.preview.published.grabRelease', { title: release.title })"
            @click="handleGrab(release)"
          >
            <Loader2 v-if="grabbing === release.guid" class="animate-spin" aria-hidden="true" />
            <Download v-else aria-hidden="true" />
            {{ t('webSerials.preview.published.grab') }}
          </Button>
        </li>
      </ul>
      <p v-if="truncated" class="mt-1 text-xs text-muted-foreground">{{ topLine }}</p>
    </template>
  </div>
</template>
