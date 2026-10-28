<script setup lang="ts">
import { ref } from 'vue'
import { Loader2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { formatDate, formatNumber } from '@/i18n/formatters'
import { useAbsHistoryRebuild } from '../composables/useAbsHistoryRebuild'

const { t } = useI18n()
const history = useAbsHistoryRebuild()
const confirmOpen = ref(false)

async function handlePreview(): Promise<void> {
  const ok = await history.loadPreview()
  if (!ok) toast.error(t('settings.integrations.editionLinks.history.previewFailed'))
}

function handleAskRebuild(): void {
  confirmOpen.value = true
}

function handleCancelRebuild(): void {
  confirmOpen.value = false
}

async function handleConfirmRebuild(): Promise<void> {
  const ok = await history.rebuild()
  confirmOpen.value = false
  if (ok) toast.success(t('settings.integrations.editionLinks.history.rebuilt', { count: history.result.value?.worksRebuilt ?? 0 }))
  else toast.error(t('settings.integrations.editionLinks.history.rebuildFailed'))
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
    <div>
      <p class="text-sm font-medium">{{ t('settings.integrations.editionLinks.history.title') }}</p>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.history.description') }}</p>
    </div>

    <div v-if="history.preview.value" class="space-y-2 rounded-lg border border-border bg-background px-3 py-3 text-xs" data-testid="history-preview">
      <p class="text-sm">
        {{
          t(
            'settings.integrations.editionLinks.history.summary',
            { works: formatNumber(history.preview.value.worksWithAbsFinish), attempts: formatNumber(history.preview.value.attemptsToReplace) },
            history.preview.value.attemptsToReplace,
          )
        }}
      </p>
      <p class="text-muted-foreground">
        {{ t('settings.integrations.editionLinks.history.untouched', { count: formatNumber(history.preview.value.worksUntouched) }) }}
      </p>
      <p class="font-semibold">
        {{
          t('settings.integrations.editionLinks.history.thisYear', {
            before: formatNumber(history.preview.value.booksReadThisYearBefore),
            after: formatNumber(history.preview.value.booksReadThisYearAfter),
          })
        }}
      </p>
      <ul v-if="history.preview.value.samples.length > 0" class="space-y-1 border-t border-border pt-2 text-muted-foreground">
        <li v-for="sample in history.preview.value.samples" :key="sample.bookId" class="flex flex-wrap items-baseline gap-x-2">
          <span class="min-w-0 truncate font-medium text-foreground">{{ sample.title ?? t('book.untitled') }}</span>
          <span class="tabular-nums">
            {{
              t('settings.integrations.editionLinks.history.sample', {
                abs: formatDate(new Date(sample.absEndedOn)),
                replaced: sample.replacedEndedOn.map((value) => formatDate(new Date(value))).join(', '),
              })
            }}
          </span>
        </li>
      </ul>
    </div>
    <p v-else-if="history.result.value" class="text-xs text-muted-foreground" data-testid="history-result">
      {{
        t('settings.integrations.editionLinks.history.result', {
          works: history.result.value.worksRebuilt,
          attempts: history.result.value.attemptsReplaced,
        })
      }}
    </p>

    <div class="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
      <Button variant="outline" size="sm" :disabled="history.previewing.value || history.rebuilding.value" @click="handlePreview">
        <Loader2 v-if="history.previewing.value" class="animate-spin" aria-hidden="true" />
        {{ t('settings.integrations.editionLinks.history.preview') }}
      </Button>
      <Button
        size="sm"
        :disabled="!history.preview.value || history.preview.value.attemptsToReplace === 0 || history.rebuilding.value"
        @click="handleAskRebuild"
      >
        {{ t('settings.integrations.editionLinks.history.rebuild') }}
      </Button>
    </div>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('settings.integrations.editionLinks.history.confirmTitle')"
      :description="t('settings.integrations.editionLinks.history.confirmDescription', { count: history.preview.value?.attemptsToReplace ?? 0 })"
      :confirm-label="t('settings.integrations.editionLinks.history.rebuild')"
      :busy="history.rebuilding.value"
      :destructive="false"
      @confirm="handleConfirmRebuild"
      @cancel="handleCancelRebuild"
    />
  </section>
</template>
