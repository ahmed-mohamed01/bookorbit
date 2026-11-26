<script setup lang="ts">
import { computed, useId, type Component } from 'vue'
import { BookImage, FileQuestionMark, FileX, Headphones } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { formatConjunctionList } from '@/i18n/formatters'
import type { StoryGuideUnavailable, StoryGuideUnavailableKind } from '../lib/story-guide-unavailable'

const props = defineProps<{ reason: StoryGuideUnavailable }>()
const { t } = useI18n()
const headingId = useId()

const ICONS: Record<StoryGuideUnavailableKind, Component> = { audio: Headphones, comic: BookImage, format: FileX, none: FileQuestionMark }
const icon = computed(() => ICONS[props.reason.kind])
const body = computed(() =>
  t(`book.detail.storyGuideTab.unavailableState.${props.reason.kind}.body`, {
    formats: formatConjunctionList(props.reason.formats.map((format) => format.toUpperCase())),
  }),
)
</script>

<template>
  <section
    class="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-5 py-12 text-center"
    :aria-labelledby="headingId"
    :data-reason="reason.kind"
    data-testid="story-guide-tab-unavailable"
  >
    <span class="mb-1.5 flex size-11 items-center justify-center rounded-xl bg-muted" aria-hidden="true">
      <component :is="icon" class="size-5" />
    </span>
    <h2 :id="headingId" class="text-base font-semibold">{{ t(`book.detail.storyGuideTab.unavailableState.${reason.kind}.title`) }}</h2>
    <p class="max-w-[46ch] text-[13.5px] text-muted-foreground">{{ body }}</p>
  </section>
</template>
