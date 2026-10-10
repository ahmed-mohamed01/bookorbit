<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen, Headphones } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'

type EditionCoverSize = 'slot' | 'result' | 'mini'

const props = withDefaults(
  defineProps<{ bookId: number; medium: CoverMedium; version?: string | null; size?: EditionCoverSize; muted?: boolean }>(),
  {
    version: null,
    size: 'slot',
    muted: false,
  },
)

// Audiobook art is square, so its frame follows the medium rather than the book's jacket.
const AUDIO_FRAME: Record<EditionCoverSize, string> = { slot: 'size-10', result: 'size-8', mini: 'size-7' }
const TEXT_FRAME: Record<EditionCoverSize, string> = { slot: 'h-12 w-8', result: 'h-[42px] w-7', mini: 'h-7 w-5' }

const { coverUrl } = useCoverVersions()
const failed = ref(false)

const isAudio = computed(() => props.medium === 'audio')
const frameClass = computed(() => (isAudio.value ? AUDIO_FRAME : TEXT_FRAME)[props.size])
const shadowClass = computed(() => (props.size === 'mini' ? 'shadow-sm' : 'shadow-md'))
const iconClass = computed(() => (props.size === 'mini' ? 'size-3' : 'size-4'))

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
  <div
    class="shrink-0 overflow-hidden rounded bg-muted"
    :class="[frameClass, shadowClass, { grayscale: muted }]"
    :data-medium="medium"
    :data-size="size"
    data-testid="edition-cover"
  >
    <img v-if="!failed" :src="src" alt="" loading="lazy" class="size-full object-cover" @error="handleError" />
    <div v-else class="flex size-full items-center justify-center text-muted-foreground" data-testid="edition-cover-fallback">
      <Headphones v-if="isAudio" :class="iconClass" aria-hidden="true" />
      <BookOpen v-else :class="iconClass" aria-hidden="true" />
    </div>
  </div>
</template>
