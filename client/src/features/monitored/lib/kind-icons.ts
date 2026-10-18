import type { Component } from 'vue'
import { BookOpen, Layers, Split, Library, Image, NotebookPen, CopyPlus, Files } from '@lucide/vue'
import type { MonitoredMarkKind } from '@bookorbit/types'

export const MONITORED_KIND_ICONS: Record<MonitoredMarkKind, Component> = {
  book: BookOpen,
  collection: Layers,
  split_part: Split,
  anthology: Library,
  graphic_novel: Image,
  supplemental: NotebookPen,
  format_variant: CopyPlus,
  duplicate: Files,
}
