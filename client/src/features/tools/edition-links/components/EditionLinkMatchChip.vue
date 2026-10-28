<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkMatchBucket } from '@bookorbit/types'
import { formatPercent } from '@/i18n/formatters'
import { BUCKET_COLOR } from '../match-display'

const props = defineProps<{ bucket: EditionLinkMatchBucket; score: number }>()

const { t } = useI18n()

const color = computed(() => BUCKET_COLOR[props.bucket])
const style = computed(() => ({
  color: color.value,
  backgroundColor: `color-mix(in oklch, ${color.value} 14%, transparent)`,
  boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color.value} 34%, transparent)`,
}))
</script>

<template>
  <span class="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap" :style="style">
    <span class="size-1.5 shrink-0 rounded-full" :style="{ backgroundColor: color }" aria-hidden="true" />
    {{ t(`tools.editionLinks.bucket.${bucket}`) }}
    <span class="tabular-nums opacity-80">{{ formatPercent(score) }}</span>
  </span>
</template>
