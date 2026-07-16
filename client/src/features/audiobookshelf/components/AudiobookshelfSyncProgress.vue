<script setup lang="ts">
import { computed } from 'vue'
import { AlertCircle, Loader2 } from '@lucide/vue'
import { useAudiobookshelfSync } from '../composables/useAudiobookshelfSync'

const { syncing, syncMode, lastResult, error } = useAudiobookshelfSync()

const resultLabel = computed(() => {
  const result = lastResult.value
  if (!result) return null
  return `${result.statusApplied} status updates, ${result.positionApplied} positions, ${result.sessionsApplied} sessions, ${result.failed} failed`
})
</script>

<template>
  <section
    v-if="syncing || lastResult || error"
    aria-live="polite"
    class="space-y-3 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5"
  >
    <div v-if="syncing" class="flex items-center gap-3">
      <Loader2 class="size-4 shrink-0 animate-spin text-primary" />
      <div>
        <p class="text-sm font-medium">{{ syncMode === 'full' ? 'Full resync in progress' : 'Sync in progress' }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Large listening histories can take several minutes.</p>
      </div>
    </div>
    <div v-if="syncing" class="h-1.5 overflow-hidden rounded-full bg-muted">
      <div class="h-full w-1/3 animate-pulse rounded-full bg-primary" />
    </div>
    <p v-else-if="resultLabel" class="text-xs text-muted-foreground">Last run: {{ resultLabel }}</p>
    <p v-if="error" class="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle class="size-3.5 shrink-0" />
      {{ error }}
    </p>
  </section>
</template>
