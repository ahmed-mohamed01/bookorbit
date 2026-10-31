<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen, Headphones } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'

const props = withDefaults(defineProps<{ bookId: number; medium: CoverMedium; version?: string | null }>(), { version: null })

const { coverUrl } = useCoverVersions()
const failed = ref(false)

const isAudio = computed(() => props.medium === 'audio')
// Audiobook art is square, so its frame follows the medium rather than the book's jacket.
const frameClass = computed(() => (isAudio.value ? 'size-10' : 'h-12 w-8'))
const src = computed(() => coverUrl(props.bookId, 'thumbnail', props.version, props.medium))

watch(
  () => [props.bookId, props.medium, props.version],
  () => {
    failed.value = false
  },
)

function handleError() {
  failed.value = true
}
</script>

<template>
  <div class="shrink-0 overflow-hidden rounded bg-muted shadow-md" :class="frameClass" :data-medium="medium" data-testid="edition-cover">
    <img v-if="!failed" :src="src" alt="" loading="lazy" class="size-full object-cover" @error="handleError" />
    <div v-else class="flex size-full items-center justify-center text-muted-foreground" data-testid="edition-cover-fallback">
      <Headphones v-if="isAudio" class="size-4" aria-hidden="true" />
      <BookOpen v-else class="size-4" aria-hidden="true" />
    </div>
  </div>
</template>
