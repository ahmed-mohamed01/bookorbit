<script setup lang="ts">
import { computed, toRef } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { useBookFileTree } from '@/features/book/composables/useBookFileTree'
import FileListCard from '@/features/book/components/detail/files/FileListCard.vue'

const props = defineProps<{ book: BookDetail }>()
const book = toRef(props, 'book')
const { groups, runtimeSeconds, selectedFile, selectFile } = useBookFileTree(book)

const runtimeLabel = computed<string | null>(() => {
  const seconds = runtimeSeconds.value
  if (seconds == null) return null
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${Math.max(minutes, 1)}m`
})

function handleSelect(id: number) {
  selectFile(id)
}
</script>

<template>
  <FileListCard
    :groups="groups"
    :selected-id="selectedFile?.id ?? null"
    :runtime-label="runtimeLabel"
    :can-download="false"
    :can-edit="false"
    :can-delete="false"
    @select="handleSelect"
  />
</template>
