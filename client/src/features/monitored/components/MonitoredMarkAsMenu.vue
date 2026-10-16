<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MoreHorizontal } from '@lucide/vue'
import { isWorkVisible, type MonitoredMarkKind, type MonitoredWork } from '@bookorbit/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import MonitoredMarkAsItems from './MonitoredMarkAsItems.vue'

/** The ⋯ overflow in the panel's corner: what this work actually is, when a plain book is not. */
const props = defineProps<{
  work: MonitoredWork
}>()
const emit = defineEmits<{
  select: [kind: MonitoredMarkKind]
}>()

const { t } = useI18n()

// A work in review for its verdict alone has no kind to tick, and Book is then a real choice: it keeps the work.
// Hiding says nothing about what the work is, so it is read as if shown.
const current = computed<MonitoredMarkKind | null>(() => {
  const { work } = props
  if (work.userKind ?? work.kind) return work.userKind ?? work.kind ?? null
  return isWorkVisible({ ...work, userVisibility: work.userVisibility === 'hidden' ? undefined : work.userVisibility }) ? 'book' : null
})

function handleSelect(kind: MonitoredMarkKind) {
  emit('select', kind)
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        :aria-label="t('monitored.panel.moreActions')"
        data-testid="mark-as-trigger"
      >
        <MoreHorizontal :size="16" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" :collision-padding="16" class="w-72 max-w-[calc(100vw-2rem)]">
      <MonitoredMarkAsItems :label="t('monitored.panel.markAs')" :note="t('monitored.panel.markAsNote')" :current="current" @select="handleSelect" />
    </DropdownMenuContent>
  </DropdownMenu>
</template>
