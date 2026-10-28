<script setup lang="ts">
import { computed } from 'vue'
import { FolderTree, Loader2, RefreshCw, Search } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkScanStatus, Library } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { formatNumber, formatRelativeFromNow } from '@/i18n/formatters'

const props = defineProps<{
  libraries: Library[]
  libraryId: string
  scan: EditionLinkScanStatus | null
  scanning: boolean
  busy: boolean
}>()

const emit = defineEmits<{ 'update:libraryId': [value: string]; scan: [] }>()

const { t } = useI18n()

const hasResults = computed(() => props.scan?.state === 'done')
const percent = computed(() => {
  const total = props.scan?.total ?? 0
  return total > 0 ? Math.min(100, Math.round(((props.scan?.processed ?? 0) / total) * 100)) : 0
})
const progressStyle = computed(() => ({ width: `${percent.value}%` }))
const lastRun = computed(() => {
  const finishedAt = props.scan?.finishedAt
  if (!finishedAt || !hasResults.value) return null
  return t('tools.editionLinks.scannedBooks', {
    count: formatNumber(props.scan?.total ?? 0),
    when: formatRelativeFromNow(new Date(finishedAt)),
  })
})

function handleLibraryChange(value: string | number): void {
  emit('update:libraryId', String(value))
}

function handleScan(): void {
  emit('scan')
}
</script>

<template>
  <section class="flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-card px-2.5 py-2">
    <div class="flex flex-wrap items-center gap-2">
      <label class="flex min-w-0 flex-1 basis-40 items-center gap-1.5 sm:flex-none">
        <span class="sr-only">{{ t('tools.editionLinks.scope') }}</span>
        <FolderTree class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Select
          class="h-8 w-full min-w-0 text-[12.5px] sm:w-auto sm:min-w-[10rem]"
          :model-value="libraryId"
          @update:model-value="handleLibraryChange"
        >
          <option value="">{{ t('tools.editionLinks.allLibraries') }}</option>
          <option v-for="library in libraries" :key="library.id" :value="String(library.id)">{{ library.name }}</option>
        </Select>
      </label>

      <span v-if="lastRun" class="hidden text-[12px] text-muted-foreground sm:inline">{{ lastRun }}</span>

      <Button class="ms-auto h-8 shrink-0" size="sm" :variant="hasResults ? 'outline' : 'default'" :disabled="scanning || busy" @click="handleScan">
        <Loader2 v-if="scanning" class="animate-spin" aria-hidden="true" />
        <RefreshCw v-else-if="hasResults" aria-hidden="true" />
        <Search v-else aria-hidden="true" />
        {{ hasResults ? t('tools.editionLinks.rescan') : t('tools.editionLinks.runScan') }}
      </Button>
    </div>

    <div v-if="scanning" role="status" aria-live="polite" class="grid gap-1">
      <div class="flex justify-between text-[12px] text-muted-foreground">
        <span>{{ t('tools.editionLinks.status.running') }}</span>
        <span class="tabular-nums">
          {{ t('tools.editionLinks.scanProgress', { processed: formatNumber(scan?.processed ?? 0), total: formatNumber(scan?.total ?? 0) }) }}
        </span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-muted">
        <div class="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" :style="progressStyle" />
      </div>
    </div>
  </section>
</template>
