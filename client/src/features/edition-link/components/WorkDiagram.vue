<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, ArrowRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { WorkPositionSync } from '@bookorbit/types'

export type AbsDirection = 'off' | 'pull' | 'push' | 'twoWay'

const props = withDefaults(
  defineProps<{
    enabled: boolean
    shareReadingState: boolean
    positionSync: WorkPositionSync
    /** Null when the Audiobookshelf settings could not be read. */
    absDirection?: AbsDirection | null
  }>(),
  { absDirection: null },
)

const { t } = useI18n()

interface Link {
  key: 'abs' | 'timing' | 'text'
  active: boolean
  twoWay: boolean
  label: string
}

const links = computed<Link[]>(() => {
  const linking = props.enabled
  // The narration timing link predates works and keeps running while the master switch is off; only
  // the position sync level stops it. The same-text link is the works mirror and needs both.
  const timing = props.positionSync !== 'off'
  const aligning = linking && timing
  const abs = props.absDirection
  return [
    {
      key: 'abs',
      active: linking && abs !== null && abs !== 'off',
      twoWay: abs === 'twoWay',
      label: abs === null ? t('settings.integrations.editionLinks.diagram.absUnknown') : t(`settings.integrations.editionLinks.diagram.abs.${abs}`),
    },
    { key: 'timing', active: timing, twoWay: true, label: t('settings.integrations.editionLinks.diagram.timing') },
    { key: 'text', active: aligning, twoWay: true, label: t('settings.integrations.editionLinks.diagram.sameText') },
  ]
})

const boxes = computed(() => ['audiobookshelf', 'audiobook', 'readAlong', 'ebook'] as const)
</script>

<template>
  <div
    class="rounded-lg border border-border bg-background px-3 py-3"
    dir="ltr"
    role="img"
    :aria-label="t('settings.integrations.editionLinks.diagram.aria')"
    data-testid="work-diagram"
  >
    <div class="flex flex-wrap items-start justify-center gap-y-3">
      <template v-for="(box, index) in boxes" :key="box">
        <div class="flex w-[4.75rem] flex-col items-center sm:w-24">
          <span
            class="flex h-9 w-full items-center justify-center rounded-md border px-1 text-center text-[11px] leading-tight font-semibold"
            :class="box === 'audiobookshelf' ? 'border-dashed border-border text-muted-foreground' : 'border-border bg-card text-foreground'"
          >
            {{ t(`settings.integrations.editionLinks.diagram.box.${box}`) }}
          </span>
        </div>
        <div v-if="index < links.length" class="flex w-12 flex-col items-center gap-0.5 sm:w-20" :data-testid="`diagram-link-${links[index]!.key}`">
          <span
            class="flex h-9 items-center"
            :class="links[index]!.active ? 'text-primary' : 'text-muted-foreground opacity-40'"
            :data-active="links[index]!.active"
          >
            <ArrowLeftRight v-if="links[index]!.twoWay" class="size-4" aria-hidden="true" />
            <ArrowRight v-else class="size-4" aria-hidden="true" />
          </span>
          <span
            class="text-center text-[10px] leading-tight"
            :class="links[index]!.active ? 'text-muted-foreground' : 'text-muted-foreground opacity-50'"
          >
            {{ links[index]!.label }}
          </span>
        </div>
      </template>
    </div>
    <p class="mt-3 text-center text-[11px]" :class="enabled && shareReadingState ? 'text-muted-foreground' : 'text-muted-foreground opacity-50'">
      {{ t('settings.integrations.editionLinks.diagram.shared') }}
    </p>
  </div>
</template>
