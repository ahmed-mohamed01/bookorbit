<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, CornerRightDown, CornerRightUp, File, FileText, Folder, FolderOpen, Headphones, Image } from '@lucide/vue'
import type { MonitoredFormat } from '@bookorbit/types'
import BookFormatChip from '@/features/book/components/BookFormatChip.vue'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { buildOwnedTree, splitPath, type OwnedFileKind, type OwnedPathFile } from '../lib/owned-path'

const props = defineProps<{
  format: MonitoredFormat
  libraryName: string
  libraryId?: number | null
  fileName: string
  filePath?: string | null
  files?: readonly OwnedPathFile[]
}>()

const emit = defineEmits<{ 'update:expanded': [value: boolean] }>()

const { t } = useI18n()
const { libraries } = useLibraries()

const expanded = ref(false)
const roots = computed(() => libraries.value.find((library) => library.id === props.libraryId)?.folders.map((folder) => folder.path) ?? [])
const tree = computed(() =>
  buildOwnedTree(
    { absolutePath: props.filePath ?? '', filename: props.fileName },
    props.files ?? [],
    roots.value,
    props.format === 'audiobook' ? 'audio' : 'ebook',
  ),
)
const title = computed(() => props.filePath || props.fileName)
const folderTitle = computed(() => `/${splitPath(props.filePath).slice(0, -1).join('/')}`)
const primary = computed(() => tree.value.rows.find((row) => row.primary))
const primaryDepth = computed(() => (expanded.value ? (primary.value?.depth ?? 1) : 1))
const formatKey = computed(() => {
  const dot = props.fileName.lastIndexOf('.')
  return dot >= 0 ? props.fileName.slice(dot + 1).toLowerCase() : props.format
})
const formatTone = computed(() => (props.format === 'audiobook' ? 'text-[var(--pill-media-audiobook)]' : 'text-[var(--pill-media-ebook)]'))
const icons = { ebook: FileText, audio: Headphones, image: Image, other: File } as const

function handleToggle() {
  expanded.value = !expanded.value
  emit('update:expanded', expanded.value)
}

function iconFor(kind: OwnedFileKind | undefined) {
  return icons[kind ?? 'other']
}

function indent(depth: number) {
  return { paddingInlineStart: `${depth}rem` }
}
</script>

<template>
  <div class="min-w-0" dir="ltr" data-testid="owned-tree">
    <button
      type="button"
      class="flex min-h-5 w-fit max-w-full min-w-0 items-start gap-1.5 rounded-xs text-start text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
      :aria-expanded="expanded"
      :title="title"
      data-testid="owned-toggle"
      @click="handleToggle"
    >
      <ChevronDown v-if="expanded" :size="12" class="mt-1 shrink-0" aria-hidden="true" data-testid="owned-chevron-down" />
      <ChevronRight v-else :size="12" class="mt-1 shrink-0" aria-hidden="true" data-testid="owned-chevron-right" />
      <FolderOpen v-if="expanded" :size="12" class="mt-1 shrink-0" aria-hidden="true" data-testid="owned-library-open" />
      <Folder v-else :size="12" class="mt-1 shrink-0" aria-hidden="true" />
      <span class="shrink-0 font-mono text-[11.5px] leading-5" data-testid="owned-library">{{ libraryName }}/</span>
      <span class="ms-1 shrink-0 text-[11px] leading-5 text-muted-foreground" :title="folderTitle" data-testid="owned-path">{{
        expanded ? t('monitored.slot.hidePath') : t('monitored.slot.fullPath')
      }}</span>
      <CornerRightUp v-if="expanded" :size="12" class="mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />
      <CornerRightDown v-else :size="12" class="mt-1.5 shrink-0 text-muted-foreground" aria-hidden="true" data-testid="owned-path-arrow" />
    </button>
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
    <template v-for="(row, index) in expanded ? tree.rows : primary ? [primary] : []" :key="`${index}:${row.name}`">
      <div
        v-if="row.type === 'folder'"
        class="flex min-h-5 items-start gap-1.5 text-muted-foreground"
        :style="indent(row.depth)"
        data-testid="owned-subfolder"
      >
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <FolderOpen :size="12" class="mt-1 shrink-0" aria-hidden="true" />
        <span class="font-mono text-[11.5px] leading-5 break-all">{{ row.name }}/</span>
      </div>
      <div v-else-if="row.primary" class="flex min-h-5 items-start gap-1.5 text-foreground" :style="indent(primaryDepth)" data-testid="owned-primary">
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <component :is="iconFor(row.kind)" :size="12" class="mt-1 shrink-0" :class="formatTone" aria-hidden="true" />
        <span class="min-w-0 font-mono text-[11.5px] leading-5 font-medium" :class="expanded ? 'break-words' : 'truncate'" data-testid="owned-file">{{
          row.name
        }}</span>
        <BookFormatChip :format-key="formatKey" primary class="mt-0.5 h-4 shrink-0 rounded-md px-1.5 text-[9px] leading-none tracking-wider" />
      </div>
      <div v-else class="flex min-h-5 items-start gap-1.5 text-muted-foreground" :style="indent(row.depth)" data-testid="owned-sibling">
        <span class="-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border" />
        <component :is="iconFor(row.kind)" :size="12" class="mt-1 shrink-0" aria-hidden="true" />
        <span class="min-w-0 font-mono text-[11.5px] leading-5 break-all">{{ row.name }}</span>
      </div>
    </template>
    <div
      v-if="expanded && tree.moreCount > 0"
      class="flex min-h-5 items-start text-muted-foreground"
      :style="indent(tree.folders.length + 1)"
      data-testid="owned-more"
    >
      <span class="font-mono text-[11.5px] leading-5">{{ t('monitored.slot.moreFiles', { count: tree.moreCount }) }}</span>
    </div>
  </div>
</template>
