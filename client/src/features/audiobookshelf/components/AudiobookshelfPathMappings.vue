<script setup lang="ts">
import { ArrowRight, FolderTree, Plus, Trash2 } from '@lucide/vue'
import PathPrefixCombobox from './PathPrefixCombobox.vue'
import type { AudiobookshelfPathMapping } from '@bookorbit/types'
import { PATH_MAPPING_MAX_ROWS } from '../audiobookshelf.constants'

const props = withDefaults(
  defineProps<{
    modelValue: AudiobookshelfPathMapping[]
    disabled?: boolean
    absFolderPaths?: string[]
    localFolderPaths?: string[]
  }>(),
  { absFolderPaths: () => [], localFolderPaths: () => [] },
)
const emit = defineEmits<{ 'update:modelValue': [value: AudiobookshelfPathMapping[]] }>()

const MAX_ROWS = PATH_MAPPING_MAX_ROWS
const PREFIX_MAX_LENGTH = 500

function updateRow(index: number, patch: Partial<AudiobookshelfPathMapping>): void {
  if (props.disabled) return
  emit(
    'update:modelValue',
    props.modelValue.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  )
}

function handleAbsPrefixUpdate(index: number, value: string): void {
  updateRow(index, { absPrefix: value })
}

function handleLocalPrefixUpdate(index: number, value: string): void {
  updateRow(index, { localPrefix: value })
}

// With exactly one candidate on each side there is only one mapping the row could mean, so it is
// filled in rather than left blank. Anything else stays empty.
function newRow(): AudiobookshelfPathMapping {
  const [absPrefix] = props.absFolderPaths
  const [localPrefix] = props.localFolderPaths
  if (props.absFolderPaths.length === 1 && props.localFolderPaths.length === 1 && absPrefix && localPrefix) {
    return { absPrefix, localPrefix }
  }
  return { absPrefix: '', localPrefix: '' }
}

function handleAddRow(): void {
  if (props.disabled || props.modelValue.length >= MAX_ROWS) return
  emit('update:modelValue', [...props.modelValue, newRow()])
}

function handleRemoveRow(index: number): void {
  if (props.disabled) return
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  )
}
</script>

<template>
  <div class="space-y-3 border-t border-border pt-4">
    <div class="flex flex-wrap items-start gap-3">
      <FolderTree class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <p class="text-sm">Folder mapping</p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          When both servers scan the same storage, map the Audiobookshelf path prefix to the BookOrbit one so items link by folder instead of
          guesswork.
        </p>
      </div>
    </div>

    <p v-if="modelValue.length === 0" class="text-xs text-muted-foreground">
      No folder mappings. Audiobookshelf items match on ASIN, ISBN, or title.
    </p>

    <div v-else class="space-y-2">
      <div v-for="(row, index) in modelValue" :key="index" class="flex flex-wrap items-center gap-2">
        <PathPrefixCombobox
          class="flex-[1_1_10rem]"
          :model-value="row.absPrefix"
          :options="absFolderPaths"
          :maxlength="PREFIX_MAX_LENGTH"
          :disabled="disabled"
          placeholder="/audiobooks"
          label="Audiobookshelf path prefix"
          testid="abs-path-prefix"
          @update:model-value="handleAbsPrefixUpdate(index, $event)"
        />
        <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
        <PathPrefixCombobox
          class="flex-[1_1_10rem]"
          :model-value="row.localPrefix"
          :options="localFolderPaths"
          :maxlength="PREFIX_MAX_LENGTH"
          :disabled="disabled"
          placeholder="/books"
          label="BookOrbit path prefix"
          testid="local-path-prefix"
          @update:model-value="handleLocalPrefixUpdate(index, $event)"
        />
        <button
          type="button"
          :disabled="disabled"
          aria-label="Remove folder mapping"
          data-testid="remove-path-mapping"
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          @click="handleRemoveRow(index)"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        :disabled="disabled || modelValue.length >= MAX_ROWS"
        data-testid="add-path-mapping"
        class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
        @click="handleAddRow"
      >
        <Plus class="size-3" />
        Add mapping
      </button>
      <slot name="actions" />
    </div>
  </div>
</template>
