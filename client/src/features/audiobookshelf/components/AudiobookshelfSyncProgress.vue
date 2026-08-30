<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { AlertCircle, Loader2, Trash2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type { AudiobookshelfCleanupResult } from '@bookorbit/types'
import { useAudiobookshelfLinkedBooks } from '../composables/useAudiobookshelfLinkedBooks'
import { useAudiobookshelfSettings } from '../composables/useAudiobookshelfSettings'
import { useAudiobookshelfSync } from '../composables/useAudiobookshelfSync'

const CLEANUP_CONFIRM_TIMEOUT_MS = 6000

const { syncing, syncMode, lastResult, error } = useAudiobookshelfSync()
const { settings, fetchSettings } = useAudiobookshelfSettings()
const { cleaningUp, cleanupStale, cleanupError, rescanning } = useAudiobookshelfLinkedBooks()

const cleanupConfirming = ref(false)
const cleanupSummary = ref<string | null>(null)
const includeManuallyUnlinked = ref(false)
let cleanupConfirmTimer: ReturnType<typeof setTimeout> | null = null

const resultLabel = computed(() => {
  const result = lastResult.value
  if (!result) return null
  return `${result.statusApplied} status updates, ${result.positionApplied} positions, ${result.sessionsApplied} sessions, ${result.failed} failed`
})

// Counted by the last full inventory walk, so it is the number of entries a cleanup would remove.
const staleCount = computed(() => settings.value?.staleCount ?? 0)
const staleLabel = computed(() => `${staleCount.value.toLocaleString()} stale ${staleCount.value === 1 ? 'entry' : 'entries'}`)

onUnmounted(() => {
  if (cleanupConfirmTimer) clearTimeout(cleanupConfirmTimer)
})

function resetCleanupConfirm(): void {
  cleanupConfirming.value = false
  includeManuallyUnlinked.value = false
  if (cleanupConfirmTimer) clearTimeout(cleanupConfirmTimer)
  cleanupConfirmTimer = null
}

function armCleanupConfirmTimer(): void {
  if (cleanupConfirmTimer) clearTimeout(cleanupConfirmTimer)
  cleanupConfirmTimer = setTimeout(resetCleanupConfirm, CLEANUP_CONFIRM_TIMEOUT_MS)
}

// Ticking the checkbox is still a decision in progress, so it must not let the arm timeout expire
// out from under the user while they are deciding.
function handleIncludeManuallyUnlinkedChange(): void {
  if (cleanupConfirming.value) armCleanupConfirmTimer()
}

function describeCleanup(result: AudiobookshelfCleanupResult): string {
  const kept: string[] = []
  if (result.staleLinked > 0) kept.push(`${result.staleLinked.toLocaleString()} linked`)
  if (result.staleExcluded > 0) kept.push(`${result.staleExcluded.toLocaleString()} excluded`)
  if (result.staleManuallyUnlinked > 0) kept.push(`${result.staleManuallyUnlinked.toLocaleString()} manually unlinked`)
  const removed = `Removed ${result.removed.toLocaleString()} stale ${result.removed === 1 ? 'entry' : 'entries'}`
  return kept.length > 0 ? `${removed}, kept ${kept.join(' and ')}` : removed
}

// First click arms the action, the second runs it: deleting rows is not undoable, and the arming
// state times out so a stray click cannot leave the button primed indefinitely.
async function handleCleanupStale(): Promise<void> {
  if (!cleanupConfirming.value) {
    cleanupConfirming.value = true
    armCleanupConfirmTimer()
    return
  }
  const payload = { includeManuallyUnlinked: includeManuallyUnlinked.value }
  resetCleanupConfirm()
  cleanupSummary.value = null
  const result = await cleanupStale(payload)
  if (result) {
    cleanupSummary.value = describeCleanup(result)
    toast.success(cleanupSummary.value)
    await fetchSettings()
  } else {
    toast.error(cleanupError.value ?? 'Failed to clean up stale Audiobookshelf entries')
  }
}
</script>

<template>
  <section
    v-if="syncing || lastResult || error || staleCount > 0 || cleanupSummary"
    aria-live="polite"
    class="space-y-3 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5"
  >
    <div v-if="syncing" role="status" class="flex items-center gap-3">
      <Loader2 class="size-4 shrink-0 animate-spin text-primary" />
      <div>
        <p class="text-sm font-medium">{{ syncMode === 'full' ? 'Full resync in progress' : 'Sync in progress' }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Large listening histories can take several minutes.</p>
      </div>
    </div>
    <div v-if="syncing" aria-hidden="true" class="flex h-1.5 items-center gap-1">
      <span class="size-1.5 rounded-full bg-primary/80 animate-pulse" />
      <span class="size-1.5 rounded-full bg-primary/60 animate-pulse delay-150" />
      <span class="size-1.5 rounded-full bg-primary/40 animate-pulse delay-300" />
    </div>
    <div v-else-if="resultLabel || staleCount > 0" class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p v-if="resultLabel" class="text-xs text-muted-foreground">Last run: {{ resultLabel }}</p>
      <template v-if="staleCount > 0">
        <span data-testid="abs-stale-count" class="text-xs text-destructive">{{ staleLabel }}</span>
        <button
          type="button"
          data-testid="abs-cleanup-stale"
          :disabled="cleaningUp || syncing || rescanning"
          title="Remove unmatched entries whose Audiobookshelf item no longer exists in your selected libraries"
          class="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          :class="
            cleanupConfirming
              ? 'border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border-border bg-muted text-muted-foreground hover:bg-muted/80'
          "
          @click="handleCleanupStale"
        >
          <Loader2 v-if="cleaningUp" class="size-3 animate-spin" />
          <Trash2 v-else class="size-3" />
          {{ cleanupConfirming ? 'Confirm' : 'Clean up' }}
        </button>
        <label
          v-if="cleanupConfirming"
          data-testid="abs-cleanup-include-manual"
          class="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <input
            v-model="includeManuallyUnlinked"
            type="checkbox"
            class="size-3.5 shrink-0 cursor-pointer rounded border-input accent-primary"
            @change="handleIncludeManuallyUnlinkedChange"
          />
          Also remove manually unlinked entries
        </label>
      </template>
    </div>
    <p v-if="cleanupSummary" data-testid="abs-cleanup-summary" class="text-xs text-muted-foreground">{{ cleanupSummary }}</p>
    <p v-if="error" class="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle class="size-3.5 shrink-0" />
      {{ error }}
    </p>
  </section>
</template>
