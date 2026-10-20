<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, CornerRightDown, CornerRightUp, File, FileText, Folder, FolderOpen, Headphones, Image, RefreshCw } from '@lucide/vue'
import type { MonitoredFormat } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { buildOwnedTree, splitPath, type OwnedFileKind, type OwnedPathFile, type OwnedTreeRow } from '../lib/owned-path'

/** How many files a card lists before the rest hide behind "Show all N files". */
const MAX_SHOWN_FILES = 3

const props = defineProps<{
  format: MonitoredFormat
  libraryName: string
  libraryId?: number | null
  fileName: string
  filePath?: string | null
  files?: readonly OwnedPathFile[]
  /** This format's own files, which the "Show all N files" count and the duration total cover. */
  contentPaths?: readonly string[]
  /** Offers the re-check icon on the library row; the page runs the author refresh behind it. */
  recheckable?: boolean
  checking?: boolean
}>()

const emit = defineEmits<{ recheck: [] }>()
/** Takes the re-check icon's place on the library row, such as the "Fix match" picker. */
const slots = defineSlots<{ action?(): unknown }>()

const { t } = useI18n()
const { libraries } = useLibraries()

const expanded = ref(false)
const allFiles = ref(false)
const roots = computed(() => libraries.value.find((library) => library.id === props.libraryId)?.folders.map((folder) => folder.path) ?? [])
// The primary file's own record carries the size the stat line and the duration total read.
const primaryFile = computed(() => props.files?.find((file) => file.absolutePath === (props.filePath ?? '') || file.filename === props.fileName))
const tree = computed(() =>
  buildOwnedTree(
    {
      absolutePath: props.filePath ?? '',
      filename: props.fileName,
      sizeBytes: primaryFile.value?.sizeBytes ?? null,
      durationSeconds: primaryFile.value?.durationSeconds ?? null,
    },
    props.files ?? [],
    roots.value,
    props.format === 'audiobook' ? 'audio' : 'ebook',
    props.contentPaths,
  ),
)
const title = computed(() => props.filePath || props.fileName)
const folderTitle = computed(() => `/${splitPath(props.filePath).slice(0, -1).join('/')}`)
const formatTone = computed(() => (props.format === 'audiobook' ? 'text-[var(--pill-media-audiobook)]' : 'text-[var(--pill-media-ebook)]'))
const icons = { ebook: FileText, audio: Headphones, image: Image, other: File } as const

/** Collapsed, every file answers to the library folder directly; expanded, each keeps its own depth. */
const shownRows = computed<OwnedTreeRow[]>(() => {
  const rows = expanded.value ? tree.value.rows : tree.value.rows.filter((row) => row.type === 'file')
  if (allFiles.value) return rows
  let shown = rows.slice(0, MAX_SHOWN_FILES)
  if (shown.at(-1)?.type === 'folder') shown = shown.slice(0, -1)
  return shown
})
const hiddenFiles = computed(() => {
  const shown = new Set(shownRows.value)
  return tree.value.rows.filter((row) => row.type === 'file' && !shown.has(row))
})
/** The toggle stays once every file is shown, so "Show fewer files" can fold the list back. */
const showToggle = computed(() => allFiles.value || hiddenFiles.value.length > 0)
/** The cover is named on the line only while its own row is out of sight. */
const hiddenCover = computed(() => (hiddenFiles.value.some((row) => row.name === tree.value.coverFileName) ? tree.value.coverFileName : null))
const durationLabel = computed(() => {
  if (props.format !== 'audiobook' || !tree.value.durationSeconds) return null
  const hours = Math.floor(tree.value.durationSeconds / 3600)
  const minutes = Math.round((tree.value.durationSeconds % 3600) / 60)
  return hours > 0 ? t('monitored.slot.durationHm', { hours, minutes }) : t('monitored.slot.durationM', { minutes })
})
const moreLabel = computed(() => {
  if (allFiles.value) return t('monitored.slot.hideAllFiles')
  // Only sidecars or artwork out of sight: say how many, since "all N files" would count the ones already shown.
  if (!hiddenFiles.value.some((row) => row.content)) return t('monitored.slot.showMoreFiles', { count: hiddenFiles.value.length })
  return t('monitored.slot.showAllFiles', { count: tree.value.contentCount })
})

function handleToggle() {
  expanded.value = !expanded.value
}

function handleToggleAllFiles() {
  allFiles.value = !allFiles.value
}

function handleRecheck() {
  emit('recheck')
}

function iconFor(kind: OwnedFileKind | undefined) {
  return icons[kind ?? 'other']
}

function indent(depth: number) {
  return { paddingInlineStart: `${depth}rem` }
}

function rowIndent(row: OwnedTreeRow) {
  return indent(expanded.value ? row.depth : 1)
}
</script>

<template>
  <div class="min-w-0" dir="ltr" data-testid="owned-tree">
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="flex min-h-5 min-w-0 flex-1 items-center gap-1.5 rounded-xs text-start text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
        :aria-expanded="expanded"
        :title="title"
        data-testid="owned-toggle"
        @click="handleToggle"
      >
        <FolderOpen v-if="expanded" :size="12" class="shrink-0" aria-hidden="true" data-testid="owned-library-open" />
        <Folder v-else :size="12" class="shrink-0" aria-hidden="true" data-testid="owned-library-closed" />
        <span class="shrink-0 font-mono text-[11.5px] leading-5" data-testid="owned-library">{{ libraryName }}/</span>
        <span class="shrink-0 text-[11px] leading-5 text-muted-foreground" :title="folderTitle" data-testid="owned-path">{{
          expanded ? t('monitored.slot.hidePath') : t('monitored.slot.fullPath')
        }}</span>
        <CornerRightUp v-if="expanded" :size="12" class="shrink-0 text-muted-foreground" aria-hidden="true" />
        <CornerRightDown v-else :size="12" class="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" data-testid="owned-path-arrow" />
      </button>
      <slot v-if="slots.action" name="action" />
      <button
        v-else-if="recheckable"
        type="button"
        :disabled="checking"
        class="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:size-11"
        :aria-label="t('monitored.slot.recheckFiles')"
        :title="t('monitored.slot.recheckFiles')"
        data-testid="owned-recheck"
        @click="handleRecheck"
      >
        <RefreshCw :size="12" :class="checking ? 'motion-safe:animate-spin' : undefined" aria-hidden="true" />
      </button>
    </div>
    <template v-if="expanded">
      <div
        v-for="(folder, index) in tree.folders"
        :key="`${index}:${folder}`"
        class="flex min-h-5 items-start gap-1.5 text-foreground"
        :style="indent(index + 1)"
        data-testid="owned-folder"
      >
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <FolderOpen :size="12" class="mt-1 shrink-0" aria-hidden="true" />
        <span class="font-mono text-[11.5px] leading-5 break-all">{{ folder }}/</span>
      </div>
    </template>
    <template v-for="(row, index) in shownRows" :key="`${index}:${row.name}`">
      <div
        v-if="row.type === 'folder'"
        class="flex min-h-5 items-start gap-1.5 text-muted-foreground"
        :style="rowIndent(row)"
        data-testid="owned-subfolder"
      >
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <FolderOpen :size="12" class="mt-1 shrink-0" aria-hidden="true" />
        <span class="font-mono text-[11.5px] leading-5 break-all">{{ row.name }}/</span>
      </div>
      <div v-else-if="row.primary" class="flex min-h-5 items-start gap-1.5 text-foreground" :style="rowIndent(row)" data-testid="owned-primary">
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <component :is="iconFor(row.kind)" :size="12" class="mt-1 shrink-0" :class="formatTone" aria-hidden="true" />
        <span
          class="min-w-0 flex-1 font-mono text-[11.5px] leading-5 font-medium"
          :class="expanded ? 'break-words' : 'truncate'"
          data-testid="owned-file"
          >{{ row.name }}</span
        >
        <span v-if="row.sizeBytes != null" class="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground" data-testid="owned-size">{{
          formatBytes(row.sizeBytes)
        }}</span>
      </div>
      <div v-else class="flex min-h-5 items-start gap-1.5 text-muted-foreground" :style="rowIndent(row)" data-testid="owned-sibling">
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <component :is="iconFor(row.kind)" :size="12" class="mt-1 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 font-mono text-[11.5px] leading-5" :class="expanded ? 'break-words' : 'truncate'">{{ row.name }}</span>
        <span v-if="row.sizeBytes != null" class="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground" data-testid="owned-size">{{
          formatBytes(row.sizeBytes)
        }}</span>
      </div>
    </template>
    <div
      v-if="showToggle || durationLabel"
      class="flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground"
      :style="indent(expanded ? tree.folders.length + 1 : 1)"
      data-testid="owned-more"
    >
      <ChevronDown v-if="showToggle" :size="12" class="shrink-0" aria-hidden="true" />
      <button
        v-if="showToggle"
        type="button"
        class="rounded-xs text-xs font-medium text-foreground underline-offset-2 transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="owned-more-toggle"
        @click="handleToggleAllFiles"
      >
        {{ moreLabel }}
      </button>
      <span v-if="durationLabel" class="text-xs"><template v-if="showToggle">&middot; </template>{{ durationLabel }}</span>
      <span v-if="hiddenCover" class="truncate font-mono text-[11.5px]">&middot; {{ hiddenCover }}</span>
    </div>
  </div>
</template>
