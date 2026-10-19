<script setup lang="ts">
import { computed, inject, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, Minus } from '@lucide/vue'
import { formatBytes } from '@/lib/formatting'
import { splitForMiddleEllipsis, type FileTreeNode } from '../composables/useReleaseFileSelection'

const props = defineProps<{
  tree: FileTreeNode
  selectable: boolean
  selectedUnits: Set<number>
  dirState: (node: FileTreeNode) => 'all' | 'some' | 'none' | 'empty'
}>()
const emit = defineEmits<{
  'toggle-unit': [index: number]
  'toggle-dir': [node: FileTreeNode]
}>()
const { t } = useI18n()
const depth = inject<number>('release-file-tree-depth', 0)
provide('release-file-tree-depth', depth + 1)
const open = ref(depth < 2)
const showAll = ref(false)
const children = computed(() => (showAll.value ? props.tree.children : props.tree.children.slice(0, 200)))
const isBook = computed(() => props.tree.unitIndex !== null)
const ticked = computed(() => props.tree.unitIndex !== null && props.selectedUnits.has(props.tree.unitIndex))
const state = computed(() => props.dirState(props.tree))
const dirClickable = computed(() => props.selectable && state.value !== 'empty')
const fileClickable = computed(() => props.selectable && isBook.value)
const dirName = computed(() => props.tree.name || t('bookRequests.batch.tree.root'))
const nameParts = computed(() => splitForMiddleEllipsis(props.tree.name))
const size = computed(() => (props.tree.sizeBytes === null ? null : formatBytes(props.tree.sizeBytes)))
const indent = computed(() => ({ paddingInlineStart: `${depth}rem` }))
const checked = computed<'true' | 'false'>(() => (ticked.value ? 'true' : 'false'))
const dirChecked = computed<'true' | 'false' | 'mixed'>(() => (state.value === 'all' ? 'true' : state.value === 'some' ? 'mixed' : 'false'))

const ROW = 'flex min-h-5 min-w-0 items-start gap-1.5 rounded-xs text-start'
const PRESS =
  'group w-full cursor-pointer hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11'
const ELBOW = '-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border'
const FILE_NAME = 'min-w-0 font-mono text-[11.5px] leading-5 break-words max-sm:line-clamp-2 max-sm:[overflow-wrap:anywhere] sm:flex'
const SLOT = 'flex size-4 shrink-0 items-center justify-center self-start pt-0.5'
const BOX_BASE = 'flex size-3 items-center justify-center rounded-[3px] transition-opacity duration-150 motion-reduce:transition-none'
const BOX_EMPTY = `${BOX_BASE} border-[1.5px] border-foreground/35 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-50`
const BOX_FILLED = `${BOX_BASE} bg-primary text-primary-foreground`
const SIZE = 'ms-auto shrink-0 ps-1.5 text-[11px] leading-5 whitespace-nowrap tabular-nums text-muted-foreground'

function handleExpand() {
  open.value = !open.value
}
function handleDirectory() {
  emit('toggle-dir', props.tree)
}
function handleFile() {
  if (props.tree.unitIndex !== null) emit('toggle-unit', props.tree.unitIndex)
}
function forwardUnit(index: number) {
  emit('toggle-unit', index)
}
function forwardDirectory(node: FileTreeNode) {
  emit('toggle-dir', node)
}
function handleShowAll() {
  showAll.value = true
}
</script>

<template>
  <div class="min-w-0" :class="{ 'rounded-md border border-dashed border-muted-foreground/35 px-2.5 py-1.5': depth === 0 }" dir="ltr">
    <template v-if="tree.kind === 'dir'">
      <div :class="[ROW, 'text-foreground']" :style="indent" data-testid="tree-folder">
        <span v-if="depth > 0" :class="ELBOW" />
        <button
          type="button"
          class="inline-flex shrink-0 items-center rounded-xs py-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:justify-center"
          :aria-expanded="open"
          :aria-label="t('bookRequests.batch.tree.toggleFolder', { name: dirName })"
          data-testid="tree-caret"
          @click="handleExpand"
        >
          <ChevronDown v-if="open" :size="12" aria-hidden="true" />
          <ChevronRight v-else :size="12" aria-hidden="true" />
        </button>
        <component
          :is="dirClickable ? 'button' : 'div'"
          :type="dirClickable ? 'button' : undefined"
          :role="dirClickable ? 'checkbox' : undefined"
          :aria-checked="dirClickable ? dirChecked : undefined"
          :class="['flex min-h-5 min-w-0 flex-1 items-start gap-1.5 rounded-xs text-start', dirClickable ? PRESS : '']"
          data-testid="tree-folder-row"
          @click="dirClickable ? handleDirectory() : undefined"
        >
          <FolderOpen v-if="open" :size="12" class="mt-1 shrink-0" aria-hidden="true" />
          <Folder v-else :size="12" class="mt-1 shrink-0" aria-hidden="true" />
          <span class="min-w-0 truncate font-mono text-[11.5px] leading-5" :title="dirName">{{ dirName }}/</span>
          <span :class="SIZE"
            >{{ t('bookRequests.batch.tree.books', { count: tree.bookCount }) }}<template v-if="size"> &middot; {{ size }}</template></span
          >
          <span :class="SLOT" data-testid="tree-slot">
            <template v-if="dirClickable">
              <span v-if="state === 'none'" :class="BOX_EMPTY" data-testid="tree-box-empty" />
              <span v-else :class="BOX_FILLED" data-testid="tree-box-filled">
                <Check v-if="state === 'all'" :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-check" />
                <Minus v-else :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-minus" />
              </span>
            </template>
          </span>
        </component>
      </div>
      <template v-if="open">
        <ReleaseFileTree
          v-for="child in children"
          :key="child.path"
          :tree="child"
          :selectable="selectable"
          :selected-units="selectedUnits"
          :dir-state="dirState"
          @toggle-unit="forwardUnit"
          @toggle-dir="forwardDirectory"
        />
        <div v-if="!showAll && tree.children.length > 200" :style="{ paddingInlineStart: `${depth + 1}rem` }">
          <button type="button" class="py-1 text-xs text-primary hover:underline" @click="handleShowAll">
            {{ t('bookRequests.batch.tree.showAll', { count: tree.children.length }) }}
          </button>
        </div>
      </template>
    </template>
    <component
      :is="fileClickable ? 'button' : 'div'"
      v-else
      :type="fileClickable ? 'button' : undefined"
      :role="fileClickable ? 'checkbox' : undefined"
      :aria-checked="fileClickable ? checked : undefined"
      :class="[ROW, fileClickable ? PRESS : '', ticked ? 'bg-primary/10' : '', isBook ? 'text-foreground' : 'text-muted-foreground']"
      :style="indent"
      data-testid="tree-file"
      @click="fileClickable ? handleFile() : undefined"
    >
      <span :class="ELBOW" />
      <component :is="isBook ? FileText : File" :size="12" class="mt-1 shrink-0" :class="{ 'text-primary': ticked }" aria-hidden="true" />
      <span :class="FILE_NAME" :title="tree.name">
        <span v-if="nameParts.head" class="min-w-0 sm:overflow-hidden sm:text-ellipsis sm:whitespace-nowrap">{{ nameParts.head }}</span>
        <span class="sm:shrink-0 sm:whitespace-nowrap">{{ nameParts.tail }}</span>
      </span>
      <span v-if="!isBook" class="mt-0.5 shrink-0 rounded-xs bg-muted px-1 text-[10px] leading-4 font-medium">{{
        t('bookRequests.batch.tree.notBook')
      }}</span>
      <span :class="SIZE">{{ size }}</span>
      <span :class="SLOT" data-testid="tree-slot">
        <template v-if="fileClickable">
          <span v-if="!ticked" :class="BOX_EMPTY" data-testid="tree-box-empty" />
          <span v-else :class="BOX_FILLED" data-testid="tree-box-filled">
            <Check :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-check" />
          </span>
        </template>
      </span>
    </component>
  </div>
</template>
