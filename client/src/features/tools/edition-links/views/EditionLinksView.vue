<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, Link2, Loader2, Search } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { EditionLinkMatch } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useEditionLinkMatches, type EditionLinkFilter } from '@/features/edition-link/composables/useEditionLinkMatches'
import EditionLinkDismissedSection from '../components/EditionLinkDismissedSection.vue'
import EditionLinkLedgerRow from '../components/EditionLinkLedgerRow.vue'
import EditionLinkScanStrip from '../components/EditionLinkScanStrip.vue'
import EditionLinkStrongBand from '../components/EditionLinkStrongBand.vue'
import EditionLinkSummaryBand from '../components/EditionLinkSummaryBand.vue'

const { t } = useI18n()
const { libraries, fetchLibraries } = useLibraries()
const { hasPermission } = usePermissions()
const links = useEditionLinkMatches()

const selectedLibraryId = ref('')
const dismissedOpen = ref(false)
const confirmOpen = ref(false)

const canUseTool = computed(() => hasPermission('library_edit_metadata'))
const showEmpty = computed(() => links.scanFinished.value && links.loaded.value && links.matches.value.length === 0)
const strongCount = computed(() => links.scan.value?.counts.strong ?? 0)
const showStrongBand = computed(() => strongCount.value > 0 && links.filter.value !== 'ready')

onMounted(() => {
  if (!canUseTool.value) return
  void Promise.all([fetchLibraries(), links.resumeScan(), links.fetchDismissals()])
})

function selectedLibrary(): number | undefined {
  return selectedLibraryId.value ? Number(selectedLibraryId.value) : undefined
}

function handleStartScan(): void {
  void links.startScan(selectedLibrary())
}

function handleLibraryChange(value: string): void {
  selectedLibraryId.value = value
  if (links.scanFinished.value) void links.setLibrary(selectedLibrary())
}

function handleFilter(filter: EditionLinkFilter | undefined): void {
  void links.setFilter(filter)
}

function handleToggleDismissed(): void {
  dismissedOpen.value = !dismissedOpen.value
}

function handleExpand(matchId: number): void {
  links.toggleExpanded(matchId)
}

function findMatch(matchId: number): EditionLinkMatch | undefined {
  return links.matches.value.find((match) => match.id === matchId)
}

async function handleLink(matchId: number): Promise<void> {
  const match = findMatch(matchId)
  if (match && (await links.link(match))) toast.success(t('tools.editionLinks.linked'))
}

function handleDismiss(matchId: number): void {
  const match = findMatch(matchId)
  if (match) void links.dismiss(match)
}

async function handleUnlink(matchId: number): Promise<void> {
  const match = findMatch(matchId)
  if (match && (await links.unlink(match))) toast.success(t('tools.editionLinks.unlinked'))
}

function handleRestore(bookIdA: number, bookIdB: number): void {
  void links.restoreDismissal(bookIdA, bookIdB)
}

function handleAskLinkAll(): void {
  confirmOpen.value = true
}

function handleCancelLinkAll(): void {
  if (!links.linkingAll.value) confirmOpen.value = false
}

async function handleConfirmLinkAll(): Promise<void> {
  const result = await links.linkAllStrong()
  confirmOpen.value = false
  if (result) toast.success(t('tools.editionLinks.linkAll.done', { linked: result.linked, skipped: result.skipped }))
}

function handlePreviousPage(): void {
  void links.setPage(links.page.value - 1)
}

function handleNextPage(): void {
  void links.setPage(links.page.value + 1)
}
</script>

<template>
  <div v-if="!canUseTool" role="alert" class="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
    {{ t('tools.editionLinks.accessDenied') }}
  </div>

  <div v-else class="flex h-full min-h-0 w-full flex-col gap-3">
    <EditionLinkScanStrip
      :libraries="libraries"
      :library-id="selectedLibraryId"
      :scan="links.scan.value"
      :scanning="links.scanning.value"
      :busy="links.loading.value"
      @update:library-id="handleLibraryChange"
      @scan="handleStartScan"
    />

    <div
      v-if="links.error.value"
      role="alert"
      class="flex shrink-0 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
      {{ links.error.value }}
    </div>

    <template v-if="links.scanFinished.value && links.scan.value">
      <EditionLinkSummaryBand
        :scan="links.scan.value"
        :active-filter="links.filter.value"
        :dismissed-open="dismissedOpen"
        @filter="handleFilter"
        @toggle-dismissed="handleToggleDismissed"
      />

      <EditionLinkStrongBand v-if="showStrongBand" :count="strongCount" :busy="links.linkingAll.value" @review="handleAskLinkAll" />

      <div v-if="links.loading.value && !links.loaded.value" class="flex flex-1 items-center justify-center" role="status">
        <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span class="sr-only">{{ t('common.loading') }}</span>
      </div>

      <section
        v-else-if="showEmpty"
        class="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border/60 bg-card/20 p-10 text-center"
      >
        <div class="grid size-14 place-items-center rounded-full bg-muted/70">
          <Link2 class="size-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <div class="space-y-1">
          <p class="text-base font-semibold text-foreground">{{ t('tools.editionLinks.empty.title') }}</p>
          <p class="max-w-md text-sm text-muted-foreground">{{ t('tools.editionLinks.empty.description') }}</p>
        </div>
      </section>

      <div v-else class="edition-ledger flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div
          class="edition-head flex h-[34px] shrink-0 items-center gap-2.5 border-b border-border bg-surface-2 px-3 text-[10.5px] font-bold tracking-wide uppercase text-muted-foreground"
        >
          <span>{{ t('tools.editionLinks.columns.match') }}</span>
          <span>{{ t('tools.editionLinks.columns.work') }}</span>
          <span class="edition-head-variants">{{ t('tools.editionLinks.columns.variants') }}</span>
          <span class="edition-head-library">{{ t('tools.editionLinks.columns.libraries') }}</span>
          <span class="edition-head-actions">{{ t('tools.editionLinks.columns.actions') }}</span>
          <span />
        </div>

        <ul class="min-h-0 flex-1 overflow-y-auto">
          <EditionLinkLedgerRow
            v-for="match in links.matches.value"
            :key="match.id"
            :match="match"
            :expanded="links.expandedIds.value.has(match.id)"
            :busy="links.busyIds.value.has(match.id)"
            @expand="handleExpand"
            @link="handleLink"
            @dismiss="handleDismiss"
            @unlink="handleUnlink"
          />
        </ul>
      </div>

      <nav
        v-if="links.totalPages.value > 1"
        class="flex shrink-0 items-center justify-center gap-3"
        :aria-label="t('tools.editionLinks.pagination.label')"
      >
        <Button variant="outline" size="sm" :disabled="links.page.value <= 1 || links.loading.value" @click="handlePreviousPage">
          {{ t('common.previous') }}
        </Button>
        <span class="text-sm text-muted-foreground">
          {{ t('tools.editionLinks.pagination.page', { page: links.page.value, total: links.totalPages.value }) }}
        </span>
        <Button variant="outline" size="sm" :disabled="links.page.value >= links.totalPages.value || links.loading.value" @click="handleNextPage">
          {{ t('common.next') }}
        </Button>
      </nav>

      <EditionLinkDismissedSection
        :dismissals="links.dismissals.value"
        :open="dismissedOpen"
        @toggle="handleToggleDismissed"
        @restore="handleRestore"
      />
    </template>

    <section
      v-else-if="!links.scanning.value && !links.error.value"
      class="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border/60 bg-card/20 p-10 text-center"
    >
      <div class="grid size-14 place-items-center rounded-full bg-muted/70">
        <Search class="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div class="space-y-1">
        <p class="text-base font-semibold text-foreground">{{ t('tools.editionLinks.initial.title') }}</p>
        <p class="max-w-md text-sm text-muted-foreground">{{ t('tools.editionLinks.initial.description') }}</p>
      </div>
      <EditionLinkDismissedSection
        :dismissals="links.dismissals.value"
        :open="dismissedOpen"
        @toggle="handleToggleDismissed"
        @restore="handleRestore"
      />
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('tools.editionLinks.linkAll.title')"
      :description="t('tools.editionLinks.linkAll.description', { count: strongCount }, strongCount)"
      :confirm-label="t('tools.editionLinks.linkAll.confirm', { count: strongCount }, strongCount)"
      :busy="links.linkingAll.value"
      :destructive="false"
      @confirm="handleConfirmLinkAll"
      @cancel="handleCancelLinkAll"
    />
  </div>
</template>

<style scoped>
.edition-ledger {
  container-type: inline-size;
  container-name: editionlinks;
}

.edition-head {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) 150px 140px 290px 30px;
}

@container editionlinks (max-width: 1240px) {
  .edition-head {
    grid-template-columns: 150px minmax(0, 1fr) 150px 290px 30px;
  }
  .edition-head .edition-head-library {
    display: none;
  }
}

@container editionlinks (max-width: 1000px) {
  .edition-head {
    grid-template-columns: 140px minmax(0, 1fr) 30px;
  }
  .edition-head .edition-head-variants,
  .edition-head .edition-head-actions {
    display: none;
  }
}

@container editionlinks (max-width: 700px) {
  .edition-head {
    display: none;
  }
}
</style>
