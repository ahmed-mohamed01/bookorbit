<script setup lang="ts">
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Check, CopyPlus, Files, Image, Layers, Library, NotebookPen, Split } from '@lucide/vue'
import { MONITORED_MARK_KINDS, type MonitoredMarkKind } from '@bookorbit/types'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

/** The "Mark as" choices inside a dropdown: the panel's for one book, the selection bar's for many. */
const props = defineProps<{
  label: string
  note: string
  /** The kind to check; absent when the choices apply to books that may differ. */
  current?: MonitoredMarkKind | null
}>()
const emit = defineEmits<{
  select: [kind: MonitoredMarkKind]
}>()

const { t } = useI18n()

const KIND_ICONS: Record<MonitoredMarkKind, Component> = {
  book: BookOpen,
  collection: Layers,
  split_part: Split,
  anthology: Library,
  graphic_novel: Image,
  supplemental: NotebookPen,
  format_variant: CopyPlus,
  duplicate: Files,
}

function handleSelect(kind: MonitoredMarkKind) {
  if (kind !== props.current) emit('select', kind)
}
</script>

<template>
  <DropdownMenuLabel class="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
    {{ label }}
  </DropdownMenuLabel>
  <DropdownMenuItem
    v-for="kind in MONITORED_MARK_KINDS"
    :key="kind"
    class="items-start gap-2.5 px-2 py-1.5"
    :role="current === undefined ? undefined : 'menuitemradio'"
    :aria-checked="current === undefined ? undefined : kind === current"
    :data-testid="`mark-as-${kind}`"
    @click="handleSelect(kind)"
  >
    <component :is="KIND_ICONS[kind]" :size="15" class="mt-0.5 shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1">
      <span class="block text-[13px] leading-tight font-medium">{{ t(`monitored.panel.markAsKinds.${kind}.title`) }}</span>
      <span class="block text-[11.5px] leading-snug text-muted-foreground">{{ t(`monitored.panel.markAsKinds.${kind}.description`) }}</span>
    </span>
    <Check v-if="kind === current" :size="15" class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
  </DropdownMenuItem>
  <DropdownMenuSeparator />
  <p class="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="mark-as-note">
    {{ note }}
  </p>
</template>
