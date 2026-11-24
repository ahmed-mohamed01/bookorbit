<script setup lang="ts">
import AiJobCover from '@/features/ai/components/AiJobCover.vue'
import type { JobDragPreviewState } from '../composables/useJobRowDrag'
import { jobSubjectLabel } from '../lib/job-copy'
import JobDetailLine from './JobDetailLine.vue'

defineProps<{ preview: JobDragPreviewState | null }>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="preview"
      class="pointer-events-none fixed top-0 z-40 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-1 text-foreground shadow-lg motion-safe:scale-[1.02]"
      :style="{
        left: `${preview.left}px`,
        width: `${preview.width}px`,
        translate: `0 ${preview.top}px`,
        transformOrigin: `${preview.offsetX}px ${preview.offsetY}px`,
      }"
      aria-hidden="true"
      data-testid="job-drag-preview"
    >
      <AiJobCover :src="preview.item.subject.image" class="h-7 w-5 rounded-[3px]" :icon-size="11" />
      <div class="min-w-0">
        <p class="truncate text-sm leading-5 font-medium">{{ jobSubjectLabel(preview.item) }}</p>
        <JobDetailLine :item="preview.item" :compact="false" :show-cost="false" />
      </div>
    </div>
  </Teleport>
</template>
