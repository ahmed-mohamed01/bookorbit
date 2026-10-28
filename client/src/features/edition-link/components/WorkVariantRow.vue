<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkVariant, WorkVariantRole } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
import { formatPercent, formatRelativeTimeFromNow } from '@/i18n/formatters'
import { variantChipCode } from '../lib/work-roles'
import WorkRoleChip from './WorkRoleChip.vue'

const props = defineProps<{ variant: WorkVariant; thisRole: WorkVariantRole | null }>()

const { t } = useI18n()

const chipLabel = computed(() => variantChipCode(props.variant, t(`book.detail.editionLink.work.role.${props.variant.role}`)))
const percentage = computed(() => (props.variant.progress === null ? null : Math.max(0, Math.min(100, props.variant.progress))))
const finished = computed(() => (percentage.value ?? 0) >= 100)

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return hours > 0 ? t('book.detail.details.durationHm', { hours, minutes }) : t('book.detail.details.durationM', { minutes })
}

const measure = computed(() => {
  if (props.variant.durationSeconds !== null) return formatDuration(props.variant.durationSeconds)
  if (props.variant.sizeBytes !== null) return formatBytes(props.variant.sizeBytes)
  return ''
})

const percentLabel = computed(() => (percentage.value === null ? '' : formatPercent(Math.round(percentage.value) / 100)))

const sourceNote = computed(() => {
  if (props.thisRole !== null && props.variant.role === props.thisRole) return t('book.detail.editionLink.work.duplicateOfThis')
  const source = props.variant.progressSource
  if (source === null) return null
  if (source === 'mirror') return t('book.detail.editionLink.work.source.mirror')
  const name = t(`book.detail.editionLink.work.source.${source}`)
  if (!props.variant.progressUpdatedAt) return name
  return t('book.detail.editionLink.work.sourceWhen', { source: name, when: formatRelativeTimeFromNow(props.variant.progressUpdatedAt) })
})
</script>

<template>
  <li class="flex flex-col gap-0.5" data-testid="work-variant-row">
    <div class="flex items-center gap-2.5">
      <WorkRoleChip :role="variant.role" :label="chipLabel" />

      <template v-if="percentage !== null">
        <span class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <span class="block h-full rounded-full" :class="finished ? 'bg-emerald-500' : 'bg-primary'" :style="{ width: `${percentage}%` }" />
        </span>
        <span class="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ percentLabel }}</span>
      </template>
      <span v-else class="min-w-0 flex-1" />

      <span class="w-16 shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground">{{ measure }}</span>
    </div>

    <p class="min-w-0 truncate ps-[3.75rem] text-[11px] text-muted-foreground">
      <RouterLink
        :to="{ name: 'book-detail', params: { bookId: variant.bookId } }"
        class="hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {{ variant.libraryName }}
      </RouterLink>
      <template v-if="sourceNote">
        <span aria-hidden="true"> &middot; </span>
        <span>{{ sourceNote }}</span>
      </template>
    </p>
  </li>
</template>
