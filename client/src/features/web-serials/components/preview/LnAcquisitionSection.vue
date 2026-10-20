<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Permission, type ReleaseCandidateItem } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLightNovelAcquisition } from '../../composables/useLightNovelAcquisition'
import type { PublishedSeries } from '../../lib/publishedVolumes'
import { releaseKey } from '../../lib/lnAcquisition'
import { messageOf } from '../../lib/messageOf'
import LnVolumeGrid from './acquisition/LnVolumeGrid.vue'
import LnSearchStrip from './acquisition/LnSearchStrip.vue'
import LnSuggestionCard from './acquisition/LnSuggestionCard.vue'
import LnReleaseRow from './acquisition/LnReleaseRow.vue'
import LnReleaseFiles from './acquisition/LnReleaseFiles.vue'
import LnOtherFormats from './acquisition/LnOtherFormats.vue'
import LnRequesterPanel from './acquisition/LnRequesterPanel.vue'
import LnDownloadBar from './acquisition/LnDownloadBar.vue'
import LnDownloadProgress from './acquisition/LnDownloadProgress.vue'
const props = defineProps<{ series: PublishedSeries; open: boolean }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission(Permission.ManageBookRequests))
const role = computed(() => (canManage.value ? ('approver' as const) : ('requester' as const)))
const series = computed(() => (props.open ? props.series : null))
const {
  state,
  volumeFilter,
  toggleVolume,
  showMissingOnly,
  clearFilter,
  search,
  query,
  searchWith,
  suggestion,
  pickSuggestion,
  releases,
  picks,
  togglePick,
  fileSelection,
  inspect,
  inspections,
  inspecting,
  inspectionErrors,
  bar,
  clients,
  hasTorrentPicks,
  clientId,
  send,
  downloads,
  closeDraft,
  error,
  sending,
  typedCount,
  requesting,
  requestVolumes,
  cancelRequest,
} = useLightNovelAcquisition(series, { role, canManage })
const { status, indexers, pending, results } = search
const expanded = ref(new Set<string>())
const volumes = computed(() => state.value?.volumes ?? [])
const planned = computed(() => new Set(bar.value.volumes))
const novels = computed(() => releases.value.filter((release) => !release.kind && release.volumes.length))
const otherFormats = computed(() => releases.value.filter((release) => release.kind && release.volumes.length))
const unmatched = computed(() => releases.value.filter((release) => !release.volumes.length))
const requestSummary = computed(() => {
  const count = volumes.value.filter((volume) => volume.state === 'requested').length
  return count ? t('webSerials.acquisition.count.requested', count) : undefined
})
const errorMessage = computed(() => (error.value ? messageOf(error.value, 'webSerials.api.requests') : null))
watch(
  () => props.open,
  (open) => {
    if (!open) closeDraft()
  },
  { flush: 'sync' },
)
watch(
  () => props.series.matchId,
  () => expanded.value.clear(),
)
function delivery(release: ReleaseCandidateItem) {
  return indexers.value.find((indexer) => indexer.indexerId === release.indexerId)?.delivery ?? 'torrent'
}
function needed(release: { volumes: number[] }) {
  return release.volumes.filter((volume) => volumes.value.some((item) => item.volume === volume && item.state === 'missing')).length
}
function viewFiles(release: ReleaseCandidateItem) {
  const key = releaseKey(release)
  if (expanded.value.has(key)) expanded.value.delete(key)
  else {
    expanded.value.add(key)
    void inspect(release)
  }
}
function selectFiles(release: ReleaseCandidateItem, indexes: Set<number>) {
  fileSelection.value.set(releaseKey(release), indexes)
}
function selectClient(event: Event) {
  clientId.value = Number((event.target as HTMLSelectElement).value)
}
function selectVolumes(selected: Set<number>) {
  volumeFilter.value = selected
}
function setCount(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  typedCount.value = Number.isInteger(value) && value > 0 ? value : null
}
</script>
<template>
  <section class="flex flex-col gap-5" data-testid="ln-acquisition">
    <label v-if="!props.series.publication?.finalVolume" class="space-y-2 text-sm">
      {{ t('webSerials.acquisition.volumes') }}
      <input type="number" min="1" class="input-field w-full" :value="typedCount ?? ''" @change="setCount" />
    </label>
    <p v-if="errorMessage" role="alert" class="text-sm text-destructive">{{ errorMessage }}</p>
    <LnVolumeGrid
      :volumes="volumes"
      :selected="volumeFilter"
      :planned="planned"
      :role="role"
      @toggle="toggleVolume"
      @show-missing="showMissingOnly"
      @clear="clearFilter"
    />
    <template v-if="canManage">
      <LnSearchStrip
        :searching="status === 'loading'"
        :indexers="indexers"
        :pending="pending"
        :result-count="results.length"
        :query="query"
        :alt-titles="props.series.altTitles ?? []"
        @search="searchWith"
      />
      <LnSuggestionCard v-if="suggestion && suggestion.releases.length" :suggestion="suggestion" :disabled="sending" @select="pickSuggestion" />
      <div class="space-y-3">
        <div v-for="release in novels" :key="releaseKey(release)">
          <LnReleaseRow
            :release="release"
            :delivery="delivery(release)"
            :volumes="release.volumes"
            :needed-count="needed(release)"
            :selected="picks.has(releaseKey(release))"
            :expanded="expanded.has(releaseKey(release))"
            @select="togglePick(release)"
            @view-files="viewFiles(release)"
          >
            <p v-if="inspecting.has(releaseKey(release))" role="status" class="p-4 text-xs text-muted-foreground">
              {{ t('webSerials.acquisition.searchingChip') }}
            </p>
            <LnReleaseFiles
              v-if="inspections.get(releaseKey(release))?.selection"
              :manifest="inspections.get(releaseKey(release))!.selection!"
              :volumes="volumes"
              :selected="fileSelection.get(releaseKey(release))"
              @change="selectFiles(release, $event)"
            />
          </LnReleaseRow>
          <p v-if="inspectionErrors.has(releaseKey(release))" role="alert" class="p-4 text-xs text-destructive">
            {{ messageOf(inspectionErrors.get(releaseKey(release)), 'webSerials.api.releases') }}
          </p>
        </div>
      </div>
      <LnOtherFormats v-if="otherFormats.length" :releases="otherFormats" />
      <details v-if="unmatched.length" class="space-y-3">
        <summary class="cursor-pointer text-xs text-muted-foreground">
          {{ t('webSerials.acquisition.unmatched', { count: unmatched.length }) }}
        </summary>
        <div v-for="release in unmatched" :key="releaseKey(release)">
          <LnReleaseRow
            :release="release"
            :delivery="delivery(release)"
            :volumes="release.volumes"
            :needed-count="needed(release)"
            :selected="picks.has(releaseKey(release))"
            :expanded="expanded.has(releaseKey(release))"
            @select="togglePick(release)"
            @view-files="viewFiles(release)"
          >
            <p v-if="inspecting.has(releaseKey(release))" role="status" class="p-4 text-xs text-muted-foreground">
              {{ t('webSerials.acquisition.searchingChip') }}
            </p>
            <LnReleaseFiles
              v-if="inspections.get(releaseKey(release))?.selection"
              :manifest="inspections.get(releaseKey(release))!.selection!"
              :volumes="volumes"
              :selected="fileSelection.get(releaseKey(release))"
              @change="selectFiles(release, $event)"
            />
          </LnReleaseRow>
          <p v-if="inspectionErrors.has(releaseKey(release))" role="alert" class="p-4 text-xs text-destructive">
            {{ messageOf(inspectionErrors.get(releaseKey(release)), 'webSerials.api.releases') }}
          </p>
        </div>
      </details>
      <LnDownloadProgress :downloads="downloads" />
      <LnDownloadBar v-bind="bar" :sending="sending" @download="send">
        <select
          v-if="hasTorrentPicks"
          class="select-field h-10 max-w-full"
          :value="clientId ?? ''"
          :aria-label="t('bookRequests.grab.client')"
          @change="selectClient"
        >
          <option v-for="client in clients" :key="client.id" :value="client.id">{{ client.name }}</option>
        </select>
      </LnDownloadBar>
    </template>
    <LnRequesterPanel
      v-else
      :volumes="volumes"
      :selected="volumeFilter"
      :request-summary="requestSummary"
      :busy="requesting"
      @update:selected="selectVolumes"
      @request="requestVolumes"
      @cancel="cancelRequest"
    />
  </section>
</template>
