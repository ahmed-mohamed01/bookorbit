<script setup lang="ts">
import { BookOpen, Headphones } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat } from '@bookorbit/types'

withDefaults(
  defineProps<{
    format: MonitoredFormat
    value?: string
    muted?: boolean
  }>(),
  { value: undefined, muted: false },
)

const { t } = useI18n()
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
    :class="
      muted
        ? 'border-border bg-muted text-muted-foreground'
        : format === 'ebook'
          ? 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]'
          : 'border-[var(--pill-koreader)]/40 bg-[var(--pill-koreader)]/10 text-[var(--pill-koreader)]'
    "
  >
    <BookOpen v-if="format === 'ebook'" :size="11" />
    <Headphones v-else :size="11" />
    {{ value ?? t(`monitored.formats.${format}`) }}
  </span>
</template>
