<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, Globe, Magnet, Newspaper } from '@lucide/vue'
import { compressVolumeRanges, type DownloadDelivery, type ReleaseCandidateItem } from '@bookorbit/types'
import { protocolChipClass } from '@/features/book-requests/sourceColors'
import { formatBytes } from '@/lib/formatting'
const props = withDefaults(
  defineProps<{
    release: ReleaseCandidateItem
    selected: boolean
    expanded?: boolean
    volumes?: number[]
    neededCount?: number
    delivery: DownloadDelivery
    blocked?: boolean
    canViewFiles?: boolean
  }>(),
  { volumes: () => [], neededCount: 0, canViewFiles: true },
)
const emit = defineEmits<{ select: []; 'view-files': [] }>()
const { t } = useI18n()
const meta = computed(() =>
  [
    props.release.language,
    props.release.format?.toUpperCase(),
    props.release.sizeBytes === null ? null : formatBytes(props.release.sizeBytes),
    props.release.seeders === null ? null : t('webSerials.acquisition.seeders', props.release.seeders),
    props.release.publishedAt?.slice(0, 10),
  ]
    .filter(Boolean)
    .join(' · '),
)
const volumeLabel = computed(() =>
  props.volumes.length
    ? t('webSerials.acquisition.volumeRange', {
        range: compressVolumeRanges(props.volumes),
      })
    : '',
)
function select() {
  if (!props.blocked) emit('select')
}
function viewFiles() {
  emit('view-files')
}
</script>
<template>
  <article class="rounded-xl border bg-card" :class="[selected ? 'border-primary/40 bg-primary/10' : 'border-border', blocked ? 'opacity-60' : '']">
    <div class="flex flex-wrap items-start gap-3.5 px-4 py-3.5">
      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-lg border text-sm font-bold"
        :class="release.score >= 85 ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning'"
        >{{ release.score }}</span
      >
      <div class="min-w-0 flex-1 space-y-1.5">
        <p class="truncate text-sm font-semibold" :title="release.title">{{ release.title }}</p>
        <div class="flex flex-wrap items-center gap-1.5 text-xs">
          <span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium" :class="protocolChipClass(delivery)">
            <Magnet v-if="delivery === 'torrent'" :size="11" aria-hidden="true" />
            <Newspaper v-else-if="delivery === 'usenet'" :size="11" aria-hidden="true" />
            <Globe v-else :size="11" aria-hidden="true" />
            {{ t(`bookRequests.releases.protocol.${delivery === 'file' ? 'directPill' : delivery}`) }} </span
          ><span class="rounded-full border border-border px-2 py-1">{{ release.indexerName }}</span
          ><span v-if="release.bookCount !== undefined || release.fileCount !== null" class="rounded-full border border-border px-2 py-1">{{
            t(
              release.bookCount !== undefined ? 'webSerials.acquisition.books' : 'webSerials.acquisition.files',
              release.bookCount ?? release.fileCount ?? 0,
            )
          }}</span
          ><span v-if="release.tier !== null" class="rounded-full bg-info/10 px-2 py-1 text-info">{{
            release.tierName ?? t('webSerials.acquisition.tier', { count: release.tier + 1 })
          }}</span
          ><span
            v-if="volumeLabel"
            class="rounded-full px-2 py-1"
            :class="neededCount ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'"
            >{{ volumeLabel }} · {{ t(neededCount ? 'webSerials.acquisition.youNeed' : 'webSerials.acquisition.youHave', neededCount) }}</span
          ><span v-if="release.freeleech" class="rounded-full bg-success/10 px-2 py-1 text-success">{{ t('webSerials.acquisition.freeleech') }}</span
          ><span
            v-if="release.vipOnly"
            class="rounded-full px-2 py-1"
            :class="blocked ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'"
            >{{ t('webSerials.acquisition.vip') }}</span
          ><span v-if="release.alreadyGrabbed" class="rounded-full bg-muted px-2 py-1 text-muted-foreground">{{
            t('webSerials.acquisition.grabbed')
          }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ meta }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          v-if="canViewFiles"
          type="button"
          class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs"
          :aria-expanded="expanded"
          @click="viewFiles"
        >
          <Folder :size="14" aria-hidden="true" />{{ t('webSerials.acquisition.viewFiles') }}</button
        ><button
          type="button"
          class="h-9 min-w-23 rounded-lg border border-primary/40 px-3 text-xs font-semibold disabled:cursor-not-allowed"
          :class="selected ? 'bg-primary text-primary-foreground' : 'text-primary'"
          :disabled="blocked"
          :aria-pressed="selected"
          :aria-label="t(selected ? 'webSerials.acquisition.deselectRelease' : 'webSerials.acquisition.selectRelease', { title: release.title })"
          @click="select"
        >
          {{ t(blocked ? 'webSerials.acquisition.needsVip' : selected ? 'webSerials.acquisition.selected' : 'webSerials.acquisition.select') }}
        </button>
      </div>
    </div>
    <slot v-if="expanded" />
  </article>
</template>
