<script setup lang="ts">
import { computed, inject, provide, ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, File, FileText, Folder, FolderOpen, Minus } from '@lucide/vue'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useReleaseFileName } from '../composables/useReleaseFileName'
import { formatBytes } from '@/lib/formatting'
import { type FileTreeNode } from '../composables/useReleaseFileSelection'

const props = withDefaults(
  defineProps<{
    tree: FileTreeNode
    selectable: boolean
    selectedUnits: Set<number>
    prefix?: string
    /** False when which file belongs to which book is unknown, so counts and positions would be guesses. */
    showBooks?: boolean
    dirState: (node: FileTreeNode) => 'all' | 'some' | 'none' | 'empty'
  }>(),
  { prefix: undefined, showBooks: true },
)
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
const dirClickable = computed(() => props.selectable && state.value !== 'empty' && !props.tree.imported)
const fileClickable = computed(() => props.selectable && isBook.value && !props.tree.imported)
const dirName = computed(() => props.tree.name || t('bookRequests.batch.tree.root'))
const siblingPrefix = computed(() => {
  const names = props.tree.children.filter((node) => node.kind === 'file').map((node) => node.name)
  if (names.length < 2) return ''
  let prefix = names[0]!
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && prefix[i] === name[i]) i++
    prefix = prefix.slice(0, i)
  }
  prefix = prefix.slice(0, prefix.search(/[^\s_-]*$/))
  return prefix.length > 12 ? prefix : ''
})
const root = inject<ComputedRef<FileTreeNode>>(
  'release-file-tree-root',
  computed(() => props.tree),
)
provide('release-file-tree-root', root)
const inheritedBooks = inject<ComputedRef<number[]> | null>('release-file-tree-books', null)
const books =
  inheritedBooks ??
  computed(() => {
    const indexes = new Set<number>()
    const pending = [root.value]
    while (pending.length) {
      const node = pending.pop()!
      if (node.unitIndex !== null) indexes.add(node.unitIndex)
      pending.push(...node.children)
    }
    return [...indexes].sort((a, b) => a - b)
  })
provide('release-file-tree-books', books)
const bookPosition = computed(() => books.value.indexOf(props.tree.unitIndex ?? -1) + 1)
const sheetDetail = computed(() => {
  if (!props.showBooks) return size.value ?? ''
  return t(size.value === null ? 'bookRequests.batch.tree.bookPositionNoSize' : 'bookRequests.batch.tree.bookPosition', {
    size: size.value,
    n: bookPosition.value,
    total: books.value.length,
  })
})
const {
  nameElement,
  prefixElement,
  mask,
  sheetOpen,
  handleKeyDown,
  handlePointerDown,
  handlePointerMove,
  handlePointerEnd,
  handlePointerCancel,
  handleContextMenu,
  handleScroll,
  consumeClick,
} = useReleaseFileName(
  () => props.prefix ?? '',
  () => isBook.value,
)
function handleSheetOpen(value: boolean) {
  sheetOpen.value = value
}
function handleSheetClose() {
  sheetOpen.value = false
}
function handleSheetSelect() {
  if (fileClickable.value && props.tree.unitIndex !== null) emit('toggle-unit', props.tree.unitIndex)
  sheetOpen.value = false
}
const size = computed(() => (props.tree.sizeBytes === null ? null : formatBytes(props.tree.sizeBytes)))
const indent = computed(() => ({ paddingInlineStart: `${depth}rem` }))
const checked = computed<'true' | 'false'>(() => (ticked.value ? 'true' : 'false'))
const dirChecked = computed<'true' | 'false' | 'mixed'>(() => (state.value === 'all' ? 'true' : state.value === 'some' ? 'mixed' : 'false'))

const ROW = 'flex min-h-5 min-w-0 items-center gap-1.5 rounded-xs text-start [@media(pointer:coarse)]:min-h-10'
const PRESS =
  'group w-full cursor-pointer hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-10'
const ELBOW = '-ms-2.5 h-2.5 w-2 shrink-0 rounded-es-sm border-b border-s border-border'
const FILE_NAME =
  'min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain whitespace-nowrap font-mono text-[11.5px] leading-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden cursor-grab select-none'
const SLOT = 'flex size-4 shrink-0 items-center justify-center self-start pt-0.5'
const BOX_BASE = 'flex size-3 items-center justify-center rounded-[3px] transition-opacity duration-150 motion-reduce:transition-none'
const BOX_EMPTY = `${BOX_BASE} border-[1.5px] border-foreground/35 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-50`
const BOX_DONE = `${BOX_BASE} bg-muted text-muted-foreground`
const BOX_FILLED = `${BOX_BASE} bg-primary text-primary-foreground`
const SIZE = 'ms-auto shrink-0 ps-1.5 text-[11px] leading-5 whitespace-nowrap tabular-nums text-muted-foreground'

function handleExpand() {
  open.value = !open.value
}
function handleDirectory() {
  if (dirClickable.value) emit('toggle-dir', props.tree)
}
function handleFile() {
  if (consumeClick()) return
  if (fileClickable.value && props.tree.unitIndex !== null) emit('toggle-unit', props.tree.unitIndex)
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
          class="inline-flex h-5 w-[18px] shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:size-10"
          :aria-expanded="open"
          :aria-label="t(open ? 'bookRequests.batch.tree.closeFolder' : 'bookRequests.batch.tree.openFolder')"
          data-testid="tree-folder-icon"
          @click="handleExpand"
        >
          <FolderOpen v-if="open" :size="12" aria-hidden="true" />
          <Folder v-else :size="12" aria-hidden="true" />
        </button>
        <component
          :is="dirClickable ? 'button' : 'div'"
          :type="dirClickable ? 'button' : undefined"
          :role="dirClickable ? 'checkbox' : undefined"
          :aria-checked="dirClickable ? dirChecked : undefined"
          :aria-disabled="tree.imported || undefined"
          :class="['flex min-h-5 min-w-0 flex-1 items-start gap-1.5 rounded-xs text-start', dirClickable ? PRESS : '']"
          data-testid="tree-folder-row"
          @click="handleDirectory"
        >
          <span class="min-w-0 truncate font-mono text-[11.5px] leading-5" :title="dirName">{{ dirName }}/</span>
          <span :class="SIZE"
            ><template v-if="showBooks"
              >{{ t('bookRequests.batch.tree.books', { count: tree.bookCount }) }}<template v-if="size"> &middot; </template></template
            ><template v-if="size">{{ size }}</template></span
          >
          <span :class="SLOT" data-testid="tree-slot">
            <span v-if="tree.imported" :class="BOX_DONE" data-testid="tree-box-filled">
              <Check :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-check" />
            </span>
            <template v-else-if="dirClickable">
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
          :show-books="showBooks"
          :dir-state="dirState"
          :prefix="siblingPrefix"
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
      :aria-disabled="tree.imported || undefined"
      :class="[ROW, fileClickable ? PRESS : '', ticked ? 'bg-primary/10' : '', isBook ? 'text-foreground' : 'text-muted-foreground']"
      :style="indent"
      data-testid="tree-file"
      @click="handleFile"
      @keydown="handleKeyDown"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerCancel"
      @contextmenu="handleContextMenu"
    >
      <span :class="ELBOW" />
      <component :is="isBook ? FileText : File" :size="12" class="mt-1 shrink-0" :class="{ 'text-primary': ticked }" aria-hidden="true" />
      <span ref="nameElement" :class="FILE_NAME" :style="mask" :title="tree.name" data-testid="tree-name" @scroll="handleScroll">
        <span v-if="prefix" ref="prefixElement" class="text-muted-foreground" data-testid="tree-prefix">{{ prefix }}</span
        >{{ tree.name.slice(prefix?.length ?? 0) }}
      </span>
      <span v-if="!isBook" class="mt-0.5 shrink-0 rounded-xs bg-muted px-1 text-[10px] leading-4 font-medium">{{
        t('bookRequests.batch.tree.notBook')
      }}</span>
      <span v-if="tree.imported" class="mt-0.5 shrink-0 rounded-xs bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground">{{
        t('bookRequests.batch.tree.imported')
      }}</span>
      <span :class="SIZE">{{ size }}</span>
      <span :class="SLOT" data-testid="tree-slot">
        <span v-if="tree.imported" :class="BOX_DONE" data-testid="tree-box-filled">
          <Check :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-check" />
        </span>
        <template v-else-if="fileClickable">
          <span v-if="!ticked" :class="BOX_EMPTY" data-testid="tree-box-empty" />
          <span v-else :class="BOX_FILLED" data-testid="tree-box-filled">
            <Check :size="10" :stroke-width="3" aria-hidden="true" data-testid="tree-check" />
          </span>
        </template>
      </span>
    </component>
    <Sheet v-if="sheetOpen" :open="sheetOpen" @update:open="handleSheetOpen">
      <SheetContent side="bottom" hide-close class="rounded-t-xl p-4 motion-reduce:animate-none motion-reduce:transition-none">
        <span class="mx-auto h-1 w-9 rounded-full bg-border" aria-hidden="true" />
        <SheetTitle class="text-xs text-muted-foreground">{{ t('bookRequests.batch.tree.fileName') }}</SheetTitle>
        <p class="font-mono text-xs [overflow-wrap:anywhere]">{{ tree.name }}</p>
        <SheetDescription>{{ sheetDetail }}</SheetDescription>
        <div class="flex gap-2">
          <button type="button" class="flex-1 rounded-md border border-border p-2 text-sm" @click="handleSheetClose">{{ t('common.close') }}</button>
          <button
            v-if="fileClickable"
            type="button"
            class="flex-1 rounded-md bg-primary p-2 text-sm text-primary-foreground"
            data-testid="sheet-select"
            @click="handleSheetSelect"
          >
            {{ t(ticked ? 'bookRequests.batch.tree.unselect' : 'bookRequests.batch.tree.select') }}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
