<script setup lang="ts">
import { ref } from 'vue'
import { Copy, FileEdit, Palette, Trash2, X, Check } from '@lucide/vue'
import type { AnnotationItem } from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import HighlightNoteEditor from './HighlightNoteEditor.vue'

const props = defineProps<{
  highlight: AnnotationItem
}>()

const emit = defineEmits<{
  updateNote: [id: number, note: string | null]
  updateColor: [id: number, color: string]
  delete: [id: number]
}>()

const COLORS = [
  { hex: '#FACC15', label: 'Yellow' },
  { hex: '#4ADE80', label: 'Green' },
  { hex: '#38BDF8', label: 'Blue' },
  { hex: '#F472B6', label: 'Pink' },
  { hex: '#FB923C', label: 'Orange' },
]

const editingNote = ref(false)
const showColorPicker = ref(false)
const confirmDelete = ref(false)
const copied = ref(false)

function handleCopy() {
  navigator.clipboard.writeText(props.highlight.text).catch(() => {})
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}

function handleNoteSave(note: string | null) {
  emit('updateNote', props.highlight.id, note)
  editingNote.value = false
}

function handleNoteCancel() {
  editingNote.value = false
}

function handleColorSelect(color: string) {
  if (color !== props.highlight.color) {
    emit('updateColor', props.highlight.id, color)
  }
  showColorPicker.value = false
}

function handleDeleteClick() {
  if (confirmDelete.value) {
    emit('delete', props.highlight.id)
    confirmDelete.value = false
  } else {
    confirmDelete.value = true
  }
}

function handleCancelDelete() {
  confirmDelete.value = false
}

function toggleNoteEditor() {
  editingNote.value = !editingNote.value
}

function toggleColorPicker() {
  showColorPicker.value = !showColorPicker.value
}
</script>

<template>
  <div class="rounded-lg border border-border bg-card overflow-hidden transition-colors hover:border-border/80">
    <div class="flex">
      <div class="w-1 shrink-0" :style="{ backgroundColor: highlight.color }" />
      <div class="flex-1 min-w-0 p-3 sm:p-4">
        <p class="text-sm leading-relaxed text-foreground">{{ highlight.text }}</p>

        <p v-if="highlight.note && !editingNote" class="mt-2 text-xs text-muted-foreground italic border-l-2 border-muted pl-2">
          {{ highlight.note }}
        </p>

        <HighlightNoteEditor v-if="editingNote" :initial-note="highlight.note" @save="handleNoteSave" @cancel="handleNoteCancel" />

        <div v-if="showColorPicker" class="mt-2 flex items-center gap-1.5">
          <button
            v-for="c in COLORS"
            :key="c.hex"
            class="w-6 h-6 rounded-full border-2 transition-all hover:scale-110"
            :class="highlight.color === c.hex ? 'border-foreground scale-110' : 'border-transparent'"
            :style="{ background: c.hex }"
            :title="c.label"
            @click="() => handleColorSelect(c.hex)"
          />
        </div>

        <div class="mt-2 flex items-center justify-between">
          <span class="text-[11px] text-muted-foreground">
            {{ new Date(highlight.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }}
          </span>

          <div class="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  class="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  @click="toggleNoteEditor"
                >
                  <FileEdit :size="14" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ highlight.note ? 'Edit note' : 'Add note' }}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  class="inline-flex items-center justify-center w-7 h-7 rounded transition-colors"
                  :class="showColorPicker ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
                  @click="toggleColorPicker"
                >
                  <Palette :size="14" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Change color</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  class="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  @click="handleCopy"
                >
                  <Check v-if="copied" :size="14" class="text-green-500" />
                  <Copy v-else :size="14" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ copied ? 'Copied!' : 'Copy text' }}</TooltipContent>
            </Tooltip>

            <template v-if="confirmDelete">
              <button
                class="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Cancel"
                @click="handleCancelDelete"
              >
                <X :size="14" />
              </button>
              <button
                class="inline-flex h-7 items-center justify-center rounded px-2 text-xs font-medium uppercase tracking-wide transition-colors bg-destructive/15 text-destructive ring-1 ring-destructive/40"
                @click="handleDeleteClick"
              >
                Confirm
              </button>
            </template>
            <Tooltip v-else>
              <TooltipTrigger as-child>
                <button
                  class="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
                  @click="handleDeleteClick"
                >
                  <Trash2 :size="14" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
