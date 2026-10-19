<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { AudioLines, BookOpen, FileCheck2, FileWarning, Images, Loader2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { releaseInspectionBlocksGrab } from '@bookorbit/types'
import type { DownloadClientSummary, DownloadDelivery, ReleaseFileInspection, ReleaseUnitSummary } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
import BatchSelectionBar from './BatchSelectionBar.vue'
import ReleaseFileTree from './ReleaseFileTree.vue'
import { useBatchGrab } from '../composables/useBatchGrab'
import { useReleaseFileSelection } from '../composables/useReleaseFileSelection'

const props = withDefaults(
  defineProps<{
    inspection: ReleaseFileInspection | null
    delivery?: DownloadDelivery
    loading: boolean
    failed: boolean
    /** What the tracker or the server said, where either said anything worth repeating. */
    failureReason?: string | null
    requestId?: number
    indexerId?: number
    releaseGuid?: string
    canManage?: boolean
    clients?: DownloadClientSummary[]
  }>(),
  { delivery: 'torrent', failureReason: null, requestId: 0, indexerId: 0, releaseGuid: '', canManage: false, clients: () => [] },
)
const emit = defineEmits<{ sent: [batchRequestId: number] }>()

const { t } = useI18n()

const manifest = computed(() => props.inspection?.selection ?? null)
const { tree, selectedUnits, toggleUnit, toggleDir, dirState, selectedSizeBytes, clear } = useReleaseFileSelection(manifest)
const treeStats = computed(() => {
  let files = 0
  let folders = 0
  let other = 0
  const pending = tree.value ? [tree.value] : []
  while (pending.length) {
    const node = pending.pop()!
    if (node.kind === 'dir') {
      folders += 1
      pending.push(...node.children)
    } else {
      files += 1
      if (node.unitIndex === null) other += 1
    }
  }
  return { files, folders, other }
})
const batch = useBatchGrab(() => props.canManage)
const clientId = ref<number | null>(null)
const sendError = ref<string | null>(null)

const hasSeveralBooks = computed(() => (props.inspection?.unitCount ?? 0) > 1)
const capableClients = computed(() => props.clients.filter((client) => client.fileSelection))
const selectable = computed(() => manifest.value !== null && capableClients.value.length > 0)
const showsNoClientNotice = computed(() => hasSeveralBooks.value && capableClients.value.length === 0)
const totalBytes = computed(() => {
  let total = 0
  for (const file of manifest.value?.files ?? []) {
    if (file.sizeBytes === null) return null
    total += file.sizeBytes
  }
  return total
})

watch(
  capableClients,
  (capable) => {
    if (clientId.value === null || !capable.some((client) => client.id === clientId.value)) clientId.value = capable[0]?.id ?? null
  },
  { immediate: true },
)

watch(selectedUnits, () => (sendError.value = null), { deep: true })

function handleClientId(id: number) {
  clientId.value = id
}

async function handleSend() {
  if (clientId.value === null || selectedUnits.value.size === 0) return
  const unitIndexes = [...selectedUnits.value].sort((a, b) => a - b)
  const batchRequestId = await batch.send({
    sourceRequestId: props.requestId,
    indexerId: props.indexerId,
    releaseGuid: props.releaseGuid,
    downloadClientId: clientId.value,
    unitIndexes,
  })
  if (batchRequestId === null) {
    sendError.value = batch.error.value || t('bookRequests.batch.sendFailed')
    return
  }
  const client = props.clients.find((item) => item.id === clientId.value)?.name ?? ''
  toast.success(t('bookRequests.batch.sent', { count: unitIndexes.length, client }))
  clear()
  emit('sent', batchRequestId)
}

const blocked = computed(() => releaseInspectionBlocksGrab(props.inspection?.status))

/** Only worth listing when it says something the file list does not: several books, or one in parts. */
const showsUnits = computed(() => {
  const inspection = props.inspection
  return inspection !== null && (inspection.unitCount > 1 || (inspection.units[0]?.contentFileCount ?? 0) > 1)
})

/**
 * Which of the two classes of file to mark, or neither where the list is all one class.
 *
 * Always marking the book files states the same thing at several times the volume: a release of
 * three formats and a cover said "Book file" three times over, and the one row that mattered was
 * the one saying nothing. The smaller group is marked, so the badge is always the exception.
 */
const marksFiles = computed<'book' | 'extra' | null>(() => {
  const files = props.inspection?.files ?? []
  const books = files.filter((file) => file.bookFile).length
  const extras = files.length - books
  if (books === 0 || extras === 0) return null
  return books <= extras ? 'book' : 'extra'
})

const UNIT_ICONS = { ebook: BookOpen, audiobook: AudioLines, comic: Images } as const

function summary(): string {
  const inspection = props.inspection
  if (!inspection) return ''

  switch (inspection.status) {
    case 'ready': {
      const parts = inspection.units[0]?.contentFileCount ?? 1
      return parts > 1
        ? t('bookRequests.releases.manifest.multiPartBook', { count: parts })
        : t('bookRequests.releases.manifest.ready', { count: inspection.totalFiles ?? inspection.files.length })
    }
    case 'no_supported_file':
      return t('bookRequests.releases.manifest.noSupported')
    case 'contents_unknown':
      return t('bookRequests.releases.manifest.contentsUnknown')
    case 'multiple_supported_files':
      return t(selectable.value ? 'bookRequests.releases.manifest.multipleBooksSelectable' : 'bookRequests.releases.manifest.multipleBooks', {
        count: inspection.unitCount,
      })
    case 'metadata_unavailable':
      return t(
        inspection.source === 'nzb_file'
          ? 'bookRequests.releases.manifest.usenetMetadataUnavailable'
          : inspection.source === 'shelfmark'
            ? 'bookRequests.releases.manifest.shelfmarkMetadataUnavailable'
            : 'bookRequests.releases.manifest.metadataUnavailable',
      )
  }
}

function unitLabel(unit: ReleaseUnitSummary): string {
  return unit.title ?? t('bookRequests.releases.manifest.untitledUnit')
}

/** The separator every other detail line in the picker uses, so one panel does not read differently. */
const DETAIL_SEPARATOR = ' · '

function unitDetail(unit: ReleaseUnitSummary): string {
  const parts = [
    t(`bookRequests.releases.manifest.mediaKind.${unit.mediaKind}`),
    t('bookRequests.releases.manifest.unitFiles', { count: unit.contentFileCount }),
    ...(unit.sizeBytes === null ? [] : [formatBytes(unit.sizeBytes)]),
  ]
  return parts.join(DETAIL_SEPARATOR)
}

function fileSize(sizeBytes: number | null): string | null {
  return sizeBytes === null ? null : formatBytes(sizeBytes)
}
</script>

<template>
  <div class="mt-3 rounded-lg border border-border bg-background/60 p-3">
    <p v-if="loading" role="status" class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      {{ t(props.delivery === 'usenet' ? 'bookRequests.releases.inspectingNzb' : 'bookRequests.releases.inspectingFiles') }}
    </p>

    <p v-else-if="failed" role="alert" class="flex items-start gap-2 text-xs text-destructive">
      <FileWarning class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <!-- The tracker's own sentence where there is one: "VIP torrent and you are not VIP or
             higher" says what to do next, where the generic line says only that something broke. -->
        <span class="block">{{ props.failureReason ?? t('bookRequests.releases.inspectionFailed') }}</span>
        <span class="mt-0.5 block text-muted-foreground">{{ t('bookRequests.releases.inspectionFailedHintGeneric') }}</span>
      </span>
    </p>

    <template v-else-if="inspection">
      <p :role="blocked ? 'alert' : 'status'" class="flex items-start gap-2 text-xs" :class="blocked ? 'text-destructive' : 'text-muted-foreground'">
        <FileWarning v-if="blocked" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <FileCheck2 v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{{ summary() }}</span>
      </p>

      <ul v-if="showsUnits && !selectable" class="mt-2 space-y-1.5">
        <li
          v-for="(unit, unitIndex) in inspection.units"
          :key="`${unitIndex}:${unit.title ?? ''}`"
          class="flex min-w-0 items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs"
        >
          <component :is="UNIT_ICONS[unit.mediaKind]" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block break-words text-foreground">{{ unitLabel(unit) }}</span>
            <span class="block text-muted-foreground">{{ unitDetail(unit) }}</span>
          </span>
        </li>
      </ul>

      <p v-if="showsUnits && inspection.unitCount > inspection.units.length" class="mt-2 text-xs text-muted-foreground">
        {{ t('bookRequests.releases.manifest.unitsTruncated', { shown: inspection.units.length, total: inspection.unitCount }) }}
      </p>

      <div v-if="tree" role="group" :aria-label="t('bookRequests.batch.tree.root')" class="mt-2 text-[12.5px]">
        <div class="flex flex-wrap justify-between gap-x-3 gap-y-1 px-2.5 pb-1.5 text-xs text-muted-foreground">
          <span>{{ t('bookRequests.batch.tree.summaryFiles', { files: treeStats.files, folders: treeStats.folders }) }}</span>
          <span>{{ t('bookRequests.batch.tree.summaryBooks', { books: tree.bookCount, other: treeStats.other }) }}</span>
        </div>
        <ReleaseFileTree
          :tree="tree"
          :selectable="selectable"
          :selected-units="selectedUnits"
          :dir-state="dirState"
          @toggle-unit="toggleUnit"
          @toggle-dir="toggleDir"
        />
      </div>

      <BatchSelectionBar
        v-if="selectable"
        :count="selectedUnits.size"
        :size-bytes="selectedSizeBytes"
        :total-bytes="totalBytes"
        :clients="props.clients"
        :client-id="clientId"
        :sending="batch.sending.value"
        @update:client-id="handleClientId"
        @send="handleSend"
      />
      <p v-if="sendError" role="alert" class="mt-2 text-xs text-destructive">{{ sendError }}</p>

      <p v-if="showsNoClientNotice" class="mt-2 text-xs text-muted-foreground">{{ t('bookRequests.batch.noClient') }}</p>

      <ul v-if="inspection.files.length && !tree" class="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
        <li
          v-for="(file, fileIndex) in inspection.files"
          :key="`${fileIndex}:${file.path}`"
          class="flex min-w-0 items-start gap-2 px-2.5 py-2 text-xs"
        >
          <span class="min-w-0 flex-1 break-all text-foreground">{{ file.path }}</span>
          <span
            v-if="marksFiles === 'book' && file.bookFile"
            class="shrink-0 rounded-full border border-success/40 bg-success/10 px-1.5 py-px font-medium text-success"
          >
            {{ t('bookRequests.releases.manifest.bookFile') }}
          </span>
          <span
            v-else-if="marksFiles === 'extra' && !file.bookFile"
            class="shrink-0 rounded-full border border-border px-1.5 py-px text-muted-foreground"
          >
            {{ t('bookRequests.releases.manifest.extraFile') }}
          </span>
          <span v-if="fileSize(file.sizeBytes)" class="shrink-0 text-muted-foreground tabular-nums">{{ fileSize(file.sizeBytes) }}</span>
        </li>
      </ul>

      <p v-if="inspection.truncated" class="mt-2 text-xs text-muted-foreground">
        {{
          t('bookRequests.releases.manifest.truncated', { shown: inspection.files.length, total: inspection.totalFiles ?? inspection.files.length })
        }}
      </p>

      <p v-if="inspection.ignoredFileCount > 0" class="mt-2 text-xs text-muted-foreground">
        {{ t('bookRequests.releases.manifest.ignored', { count: inspection.ignoredFileCount }) }}
      </p>
    </template>
  </div>
</template>
