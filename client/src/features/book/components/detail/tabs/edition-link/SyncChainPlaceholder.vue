<script setup lang="ts">
import { computed } from 'vue'
import type { ChainFrame, ChainViewMode } from '@/features/book/lib/sync-chain'
import { frameChromeClass } from './chain-ui'

const props = withDefaults(defineProps<{ view: ChainViewMode; label: string; note: string; noteId?: string; frame?: ChainFrame }>(), {
  frame: 'spine',
  noteId: undefined,
})

const TILE_CLASS: Record<ChainViewMode, string> = { modify: 'h-8 w-6', compact: 'h-5 w-4' }

const tileClass = computed(() => TILE_CLASS[props.view])
const chromeClass = computed(() => frameChromeClass(props.frame, 'dashed'))
</script>

<template>
  <div class="relative z-[1] flex flex-col gap-2 px-2 py-1.5" :class="chromeClass" :data-view="view">
    <div class="flex items-center gap-2.5">
      <div class="flex w-9 shrink-0 justify-center" aria-hidden="true">
        <slot name="tile" :tile-class="tileClass" />
      </div>
      <div v-if="view === 'modify'" class="flex min-w-0 flex-1 flex-col">
        <span class="text-xs font-semibold text-foreground" data-testid="sync-chain-placeholder-label">{{ label }}</span>
        <span :id="noteId" class="text-[11px] leading-snug text-pretty text-muted-foreground" data-testid="sync-chain-placeholder-note">
          {{ note }}
          <slot name="note" />
        </span>
      </div>
      <p v-else class="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs text-muted-foreground">
        <span class="shrink-0 font-semibold text-foreground" data-testid="sync-chain-placeholder-label">{{ label }}</span>
        <span :id="noteId" class="min-w-0 truncate" data-testid="sync-chain-placeholder-note">{{ note }}</span>
        <span v-if="$slots.note" class="shrink-0"><slot name="note" /></span>
      </p>
      <slot name="actions" :compact="view === 'compact'" />
    </div>
    <slot />
  </div>
</template>
