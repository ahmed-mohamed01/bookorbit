<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Loader2, Search, Send, Square, TriangleAlert, X } from '@lucide/vue'
import { Permission, WEB_SERIAL_MAX_PUBLISHED_VOLUMES } from '@bookorbit/types'
import type { ReleaseCandidateItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useAuth } from '@/features/auth/composables/useAuth'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import RequestStatusBadge from '@/features/book-requests/components/RequestStatusBadge.vue'
import { formatList, formatNumber } from '@/i18n/formatters'
import { useWebSerialPublishedVolumes } from '../../composables/useWebSerialPublishedVolumes'
import { isMatchedRequest, isVolumeMissing, type PublishedSeries, type PublishedVolumeRow } from '../../lib/publishedVolumes'
import WebSerialVolumeReleases from './WebSerialVolumeReleases.vue'

const props = defineProps<{
  series: PublishedSeries
  /** Why the section is offered: the series is licensed, or none of the user's sources carry it. Null hides it. */
  reason: 'licensed' | 'unavailable' | null
}>()

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canRequest = computed(() => hasPermission(Permission.BookRequestAccess))
const canManage = computed(() => hasPermission(Permission.ManageBookRequests))
const { user } = useAuth()
const userId = computed(() => user.value?.id ?? null)
const offered = computed(() => props.reason !== null)
const volumes = useWebSerialPublishedVolumes(toRef(props, 'series'), { canRequest, canManage, offered, userId })
const {
  visible,
  knownCount,
  rows,
  missing,
  listState,
  listError,
  pending,
  errors,
  bulk,
  stopping,
  releases,
  grabbing,
  matches,
  rematch,
  rematchBusy,
} = volumes

const hint = computed(() =>
  props.reason === 'licensed' ? t('webSerials.preview.published.hintLicensed') : t('webSerials.preview.published.hintUnavailable'),
)
const publisherLine = computed(() => {
  const names = (props.series.publication?.publishers ?? []).map((publisher) => publisher.name)
  return names.length > 0 ? t('webSerials.preview.published.publishers', { names: formatList(names) }) : null
})
const busy = computed(() => bulk.value !== null)
const progressLine = computed(() =>
  bulk.value ? t('webSerials.preview.published.requesting', { done: formatNumber(bulk.value.done), total: formatNumber(bulk.value.total) }) : null,
)
const showRows = computed(() => rows.value.length > 0 && listState.value === 'ready')

const rowViews = computed(() =>
  rows.value.map((row) => {
    const request = row.request
    const results = request ? (releases.value[request.id] ?? null) : null
    const matchState = matches.value[row.volume] ?? null
    const requesting = pending.value.has(row.volume)
    const requestable = isVolumeMissing(row)
    const rematchable = !requestable && volumes.canRematch(request)
    return {
      row,
      label: t('webSerials.preview.published.volume', { volume: formatNumber(row.volume) }),
      requestable: requestable || requesting,
      requesting,
      requestLabel: request ? t('webSerials.preview.published.requestAgain') : t('webSerials.preview.published.request'),
      findable: volumes.canFindReleases(request),
      results,
      findLabel: results ? t('webSerials.preview.published.hideReleases') : t('webSerials.preview.published.findReleases'),
      error: errors.value[row.volume] ?? null,
      searching: matchState?.state === 'searching',
      matchedTitle: matchState?.state === 'matched' ? matchState.title : isMatchedRequest(request) ? request.title : null,
      noMatch: matchState?.state === 'none',
      canRequestAnyway: matchState?.state === 'none' && requestable,
      rematchable,
      // No prefilled query: the Requests page owns its search inputs, so the requester types what to look for.
      link: { name: 'book-requests' },
    }
  }),
)

const rematchView = computed(() => {
  const held = rematch.value
  return held ? { volume: held.volume, title: held.title, requestTitle: held.request.title } : null
})

function handleCount(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  volumes.setTypedCount(raw === '' ? null : Number(raw))
}

function handleRequestAll() {
  void volumes.requestAllMissing()
}

function handleStopRequestAll() {
  volumes.stopRequestAll()
}

function handleRetryList() {
  void volumes.loadRequests()
}

function handleRequest(volume: number) {
  void volumes.requestVolume(volume)
}

function handleRequestAnyway(volume: number) {
  void volumes.requestVolumeAnyway(volume)
}

function handleRematch(row: PublishedVolumeRow) {
  void volumes.rematchVolume(row.volume)
}

function handleConfirmRematch() {
  void volumes.confirmRematch()
}

function handleCancelRematch() {
  volumes.cancelRematch()
}

function handleToggleReleases(row: PublishedVolumeRow) {
  if (!row.request) return
  if (releases.value[row.request.id]) volumes.closeReleases(row.request)
  else void volumes.findReleases(row.request)
}

function handleGrab(row: PublishedVolumeRow, release: ReleaseCandidateItem) {
  if (row.request) void volumes.grab(row.volume, row.request, release)
}
</script>

<template>
  <section v-if="visible" class="space-y-2.5" aria-labelledby="web-serial-published-title" data-testid="published-volumes">
    <div class="flex flex-wrap items-center gap-2.5">
      <h3 id="web-serial-published-title" class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {{ t('webSerials.preview.published.title') }}
      </h3>
      <span v-if="knownCount !== null" class="ms-auto text-xs text-muted-foreground tabular-nums">
        {{ t('webSerials.preview.published.knownCount', { count: knownCount }) }}
      </span>
    </div>
    <p class="text-xs text-muted-foreground">{{ hint }}</p>
    <p v-if="publisherLine" class="text-xs text-muted-foreground">{{ publisherLine }}</p>

    <div v-if="knownCount === null" class="flex min-w-0 flex-col gap-1.5">
      <label for="web-serial-published-count" class="settings-label">{{ t('webSerials.preview.published.countLabel') }}</label>
      <input
        id="web-serial-published-count"
        type="number"
        inputmode="numeric"
        min="1"
        :max="WEB_SERIAL_MAX_PUBLISHED_VOLUMES"
        class="input-field w-full sm:w-32"
        aria-describedby="web-serial-published-count-hint"
        @input="handleCount"
      />
      <p id="web-serial-published-count-hint" class="text-xs text-muted-foreground">
        {{ t('webSerials.preview.published.countHint', { max: WEB_SERIAL_MAX_PUBLISHED_VOLUMES }) }}
      </p>
    </div>

    <p v-if="listState === 'loading'" class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      {{ t('webSerials.preview.published.loading') }}
    </p>
    <div v-else-if="listState === 'error'" role="alert" class="flex flex-wrap items-center gap-2 text-xs text-destructive">
      <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
      <span>{{ listError ?? t('webSerials.preview.published.loadError') }}</span>
      <Button size="sm" variant="outline" @click="handleRetryList">{{ t('common.retry') }}</Button>
    </div>

    <template v-if="showRows">
      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="missing.length > 0" size="sm" :disabled="busy" data-testid="request-all" @click="handleRequestAll">
          <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
          <Send v-else aria-hidden="true" />
          {{ t('webSerials.preview.published.requestAll', { count: formatNumber(missing.length) }) }}
        </Button>
        <p v-else class="text-xs text-muted-foreground">{{ t('webSerials.preview.published.allRequested') }}</p>
        <Button v-if="busy" size="sm" variant="outline" :disabled="stopping" data-testid="request-all-stop" @click="handleStopRequestAll">
          <Square aria-hidden="true" />
          {{ stopping ? t('webSerials.preview.published.stopping') : t('webSerials.preview.published.stop') }}
        </Button>
        <p v-if="progressLine" class="text-xs text-muted-foreground tabular-nums" aria-live="polite">{{ progressLine }}</p>
      </div>

      <ul
        class="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border"
        :aria-label="t('webSerials.preview.published.listLabel', { title: series.title })"
      >
        <li v-for="view in rowViews" :key="view.row.volume" class="px-3 py-2" data-testid="published-volume">
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-20 text-sm font-medium text-foreground tabular-nums">{{ view.label }}</span>
            <RouterLink
              v-if="view.row.request"
              :to="{ name: 'book-request-detail', params: { id: view.row.request.id } }"
              :aria-label="t('webSerials.preview.published.openRequest', { volume: view.row.volume })"
              class="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <RequestStatusBadge :status="view.row.request.status" />
            </RouterLink>
            <span v-else class="text-xs text-muted-foreground">{{ t('webSerials.preview.published.notRequested') }}</span>
            <div class="ms-auto flex items-center gap-1.5">
              <Button
                v-if="view.findable"
                size="sm"
                variant="outline"
                :aria-label="t('webSerials.preview.published.findReleasesFor', { volume: view.row.volume })"
                :aria-expanded="view.results !== null"
                data-testid="find-releases"
                @click="handleToggleReleases(view.row)"
              >
                <X v-if="view.results" aria-hidden="true" />
                <Search v-else aria-hidden="true" />
                {{ view.findLabel }}
              </Button>
              <Button
                v-if="view.rematchable"
                size="sm"
                variant="outline"
                :disabled="view.requesting || busy"
                :aria-label="t('webSerials.preview.published.rematchFor', { volume: view.row.volume })"
                data-testid="rematch-volume"
                @click="handleRematch(view.row)"
              >
                <Loader2 v-if="view.requesting" class="animate-spin" aria-hidden="true" />
                <Search v-else aria-hidden="true" />
                {{ t('webSerials.preview.published.rematch') }}
              </Button>
              <Button
                v-if="view.requestable"
                size="sm"
                variant="outline"
                :disabled="busy || view.requesting"
                :aria-label="t('webSerials.preview.published.requestVolume', { volume: view.row.volume })"
                data-testid="request-volume"
                @click="handleRequest(view.row.volume)"
              >
                <Loader2 v-if="view.requesting" class="animate-spin" aria-hidden="true" />
                <Send v-else aria-hidden="true" />
                {{ view.requestLabel }}
              </Button>
            </div>
          </div>
          <p v-if="view.searching" role="status" class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 class="size-3 animate-spin" aria-hidden="true" />
            {{ t('webSerials.preview.published.matching') }}
          </p>
          <p v-if="view.matchedTitle" data-testid="published-matched-title" class="mt-0.5 text-xs text-muted-foreground">
            {{ view.matchedTitle }}
          </p>
          <div v-if="view.noMatch" data-testid="published-no-match" class="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span class="text-muted-foreground">{{ t('webSerials.preview.published.noMatch') }}</span>
            <RouterLink
              :to="view.link"
              class="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {{ t('webSerials.preview.published.noMatchSearch') }}
            </RouterLink>
            <Button
              v-if="view.canRequestAnyway"
              size="sm"
              variant="outline"
              :disabled="busy || view.requesting"
              data-testid="request-anyway"
              @click="handleRequestAnyway(view.row.volume)"
            >
              {{ t('webSerials.preview.published.requestAnyway') }}
            </Button>
          </div>
          <p v-if="view.error" role="alert" class="mt-1 flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {{ view.error }}
          </p>
          <WebSerialVolumeReleases
            v-if="view.results"
            :volume="view.row.volume"
            :results="view.results"
            :grabbing="grabbing"
            @grab="handleGrab(view.row, $event)"
          />
        </li>
      </ul>
    </template>

    <ConfirmDialog
      :open="rematchView !== null"
      :title="t('webSerials.preview.published.rematchTitle')"
      :description="
        rematchView ? t('webSerials.preview.published.rematchDescription', { request: rematchView.requestTitle, title: rematchView.title }) : ''
      "
      :confirm-label="t('webSerials.preview.published.rematchConfirm')"
      :busy="rematchBusy"
      @confirm="handleConfirmRematch"
      @cancel="handleCancelRematch"
    />
  </section>
</template>
