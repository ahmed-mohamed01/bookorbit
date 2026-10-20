<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReleaseCandidateItem } from '@bookorbit/types'
import { offFormatKind, releaseKey } from '../../../lib/lnAcquisition'
import { formatBytes } from '@/lib/formatting'
const props = defineProps<{ releases: ReleaseCandidateItem[] }>()
const { t } = useI18n()
const rows = computed(() =>
  props.releases.map((release) => ({
    key: releaseKey(release),
    title: release.title,
    kind: offFormatKind(release) === 'manga' ? 'webSerials.acquisition.manga' : 'webSerials.acquisition.audiobook',
    meta: [
      release.indexerName,
      release.format?.toUpperCase(),
      release.sizeBytes === null ? null : formatBytes(release.sizeBytes),
      release.seeders === null ? null : t('webSerials.acquisition.seeders', release.seeders),
    ]
      .filter(Boolean)
      .join(' · '),
  })),
)
</script>
<template>
  <section class="space-y-2.5">
    <h3 class="flex items-center gap-2.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      {{ t('webSerials.acquisition.otherFormats') }}<span class="h-px flex-1 bg-border" />
    </h3>
    <div v-for="release in rows" :key="release.key" class="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
      <span class="shrink-0 rounded-full bg-info/10 px-2 py-1 text-xs text-info">{{ t(release.kind) }}</span>
      <div class="min-w-0">
        <p class="truncate text-xs">{{ release.title }}</p>
        <p class="text-xs text-muted-foreground">
          {{ release.meta }}
        </p>
      </div>
    </div>
  </section>
</template>
