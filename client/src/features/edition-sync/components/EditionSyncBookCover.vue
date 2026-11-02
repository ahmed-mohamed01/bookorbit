<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen } from '@lucide/vue'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'

const props = withDefaults(defineProps<{ bookId: number; coverVersion?: string | null; size?: 'sm' | 'md'; lazy?: boolean }>(), {
  coverVersion: null,
  size: 'sm',
  lazy: false,
})

const { coverUrl } = useCoverVersions()
const failed = ref(false)

const src = computed(() => coverUrl(props.bookId, 'thumbnail', props.coverVersion))
const frameClass = computed(() => (props.size === 'md' ? 'h-12 w-9' : 'h-10 w-7'))
const iconClass = computed(() => (props.size === 'md' ? 'size-4' : 'size-3.5'))

watch(src, () => {
  failed.value = false
})

function handleError() {
  failed.value = true
}
</script>

<template>
  <span class="flex shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-muted-foreground" :class="frameClass">
    <img v-if="!failed" :src="src" alt="" :loading="lazy ? 'lazy' : undefined" class="size-full object-cover" @error="handleError" />
    <BookOpen v-else :class="iconClass" aria-hidden="true" />
  </span>
</template>
