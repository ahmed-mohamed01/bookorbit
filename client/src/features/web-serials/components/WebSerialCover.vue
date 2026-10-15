<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bookCoverStyle } from '@/features/book/lib/book-cover'

const props = withDefaults(
  defineProps<{
    src: string | null
    title: string
    /** Sizing lives with the caller, because a row thumbnail and a sheet header differ. */
    class?: string
  }>(),
  { class: '' },
)

const failed = ref(false)

watch(
  () => props.src,
  () => {
    failed.value = false
  },
)

const showImage = computed(() => Boolean(props.src) && !failed.value)
const fallbackStyle = computed(() => bookCoverStyle(props.title))

function handleError() {
  failed.value = true
}
</script>

<template>
  <div class="relative shrink-0 overflow-hidden rounded-sm bg-muted shadow-md" :class="props.class" :style="showImage ? undefined : fallbackStyle">
    <img v-if="showImage" :src="src ?? undefined" :alt="title" class="size-full object-cover" loading="lazy" @error="handleError" />
    <div
      v-else
      class="flex size-full items-center justify-center p-1.5 text-center text-[10px] leading-tight font-bold"
      :style="{ color: fallbackStyle.color }"
    >
      <span class="line-clamp-4 break-words">{{ title }}</span>
    </div>
  </div>
</template>
