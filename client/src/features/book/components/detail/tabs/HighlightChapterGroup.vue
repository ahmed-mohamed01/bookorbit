<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown, ChevronRight } from '@lucide/vue'
import type { AnnotationItem } from '@bookorbit/types'
import HighlightCard from './HighlightCard.vue'

defineProps<{
  chapterTitle: string
  highlights: AnnotationItem[]
}>()

const emit = defineEmits<{
  updateNote: [id: number, note: string | null]
  updateColor: [id: number, color: string]
  delete: [id: number]
}>()

const expanded = ref(true)

function toggleExpanded() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div>
    <button class="flex items-center gap-2 w-full text-left py-2 px-1 rounded-md hover:bg-muted/50 transition-colors group" @click="toggleExpanded">
      <ChevronDown v-if="expanded" :size="16" class="text-muted-foreground shrink-0" />
      <ChevronRight v-else :size="16" class="text-muted-foreground shrink-0" />
      <span class="text-sm font-medium text-foreground truncate">{{ chapterTitle }}</span>
      <span class="text-xs text-muted-foreground shrink-0">({{ highlights.length }})</span>
    </button>

    <div v-if="expanded" class="space-y-2 ml-6 mt-1">
      <HighlightCard
        v-for="h in highlights"
        :key="h.id"
        :highlight="h"
        @update-note="(id, note) => emit('updateNote', id, note)"
        @update-color="(id, color) => emit('updateColor', id, color)"
        @delete="(id) => emit('delete', id)"
      />
    </div>
  </div>
</template>
