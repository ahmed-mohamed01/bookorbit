<script setup lang="ts">
import { CheckCheck } from '@lucide/vue'
import { useI18n } from 'vue-i18n'

import { Button } from '@/components/ui/button'
import { formatNumber } from '@/i18n/formatters'

defineProps<{ count: number; busy: boolean }>()
const emit = defineEmits<{ review: [] }>()

const { t } = useI18n()

function handleReview(): void {
  emit('review')
}
</script>

<template>
  <div
    class="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--pill-success)]/30 bg-[var(--pill-success)]/10 px-3 py-2 text-[12.5px]"
    data-testid="strong-band"
  >
    <CheckCheck class="size-4 shrink-0 text-[var(--pill-success)]" aria-hidden="true" />
    <p class="font-semibold text-foreground">{{ t('tools.editionLinks.strongBand.title', { count: formatNumber(count) }, count) }}</p>
    <p class="hidden text-muted-foreground md:block">{{ t('tools.editionLinks.strongBand.hint') }}</p>
    <Button class="ms-auto" size="sm" :disabled="busy" @click="handleReview">{{ t('tools.editionLinks.strongBand.action') }}</Button>
  </div>
</template>
