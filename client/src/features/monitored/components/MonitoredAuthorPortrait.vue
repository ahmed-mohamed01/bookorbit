<script setup lang="ts">
import { computed } from 'vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import AuthorPortrait from '@/features/author/components/AuthorPortrait.vue'

const props = withDefaults(
  defineProps<{
    name: string
    imageUrl?: string | null
    coverBookId?: number | null
    showSourceBadge?: boolean
  }>(),
  { imageUrl: null, coverBookId: null, showSourceBadge: false },
)

const { authorCoverFallback } = useDisplaySettings()

const subject = computed(() => ({
  id: props.name,
  name: props.name,
  imageUrl: props.imageUrl,
  coverBookId: props.coverBookId,
}))
</script>

<template>
  <AuthorPortrait :author="subject" :show-source-badge="showSourceBadge" :cover-fallback="authorCoverFallback" />
</template>
