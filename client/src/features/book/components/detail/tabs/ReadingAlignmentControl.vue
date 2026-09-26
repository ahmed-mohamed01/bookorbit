<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, AudioLines, Ban, CheckCircle2, Loader2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Permission, type BookDetail, type EditionLinkMember } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { getBookLinkModality, useEditionLink } from '@/features/book/composables/useEditionLink'
import { useReadingAlignment } from '@/features/book/composables/useReadingAlignment'
import { useReadAlongSection } from '@/features/book/composables/useReadAlongSection'
import type { EditionFormat } from '@/features/book/composables/useLinkEditionPanel'
import PositionSyncSection from './edition-link/PositionSyncSection.vue'
import ReadAlongSection from './edition-link/ReadAlongSection.vue'

const props = defineProps<{ book: BookDetail }>()

const { t } = useI18n()

const modality = computed(() => getBookLinkModality(props.book.files))
const needsLink = computed(() => modality.value === 'text' || modality.value === 'audio')

const editionLink = useEditionLink(props.book.id)
const alignment = useReadingAlignment()
const readAlongSection = useReadAlongSection(() => props.book.id)
const { readAlong, canGenerate } = readAlongSection

const { hasPermission } = usePermissions()
const canEditMetadata = computed(() => hasPermission(Permission.LibraryEditMetadata))

// One record holding both formats is its own pair, so it never reaches the Link popover and the
// read-along section lives here instead. Visible to anyone who can open the book: the section gates
// its own actions on `canGenerate`, so a reader on a dual-format book still learns a read-along exists.
const showReadAlongSection = computed(() => modality.value === 'both' && editionLink.link.value === null)

// A self-pair has no edition-link members to read a title from, so the build's own output book
// stands in for the section's ready state.
const readAlongMember = computed<EditionLinkMember | null>(() => {
  const output = readAlong.outputBook.value
  return output ? { id: output.id, title: output.title, authorName: null, progress: null, narrationPercentage: null } : null
})

const checked = ref(false)
const open = ref(false)

const pairExists = computed(() => {
  if (modality.value === 'both') return true
  if (needsLink.value) return editionLink.link.value !== null
  return false
})

// A book that still needs a counterpart linked shows nothing here: the adjacent Link edition control
// owns that action. The status only surfaces once a pair exists (linked, or one record with both formats).
const visible = computed(() => modality.value !== 'none' && pairExists.value)

const statusLabel = computed(() => t(`book.detail.readingAlignment.status.${alignment.status.value}`))

const statusIcon = computed(() => {
  switch (alignment.status.value) {
    case 'ready':
      return CheckCircle2
    case 'building':
      return Loader2
    case 'failed':
      return AlertTriangle
    case 'unalignable':
      return Ban
    default:
      return AudioLines
  }
})

const statusIconClass = computed(() => {
  switch (alignment.status.value) {
    case 'ready':
      return 'text-primary'
    case 'building':
      return 'text-foreground animate-spin'
    case 'failed':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
})

const counterpartModality = computed<EditionFormat | null>(() => {
  if (modality.value === 'text') return 'audiobook'
  if (modality.value === 'audio') return 'ebook'
  return null
})
const counterpartTitle = computed(() => (needsLink.value ? (editionLink.linkedCounterpart.value?.title ?? null) : null))

async function loadInitialState() {
  if (modality.value === 'none') {
    checked.value = true
    return
  }
  const loads: Promise<unknown>[] = [alignment.fetchStatus(props.book.id)]
  if (needsLink.value) loads.push(editionLink.loadForBook())
  await Promise.all(loads)
  if (showReadAlongSection.value) void readAlong.fetchStatus(props.book.id)
  checked.value = true
}

onMounted(loadInitialState)

async function handleBuild(force: boolean) {
  await alignment.build(props.book.id, force)
  if (alignment.error.value) toast.error(t('book.detail.readingAlignment.buildFailed'))
}

function handleOpenChange(next: boolean) {
  open.value = next
  if (!next || !showReadAlongSection.value) return
  readAlongSection.resetChoices()
  void readAlong.fetchStatus(props.book.id)
  // The lookup is refused without the upload permission, and only offers anything to a pair with no
  // read-along and no build running.
  if (canGenerate.value && !readAlong.outputBook.value && readAlong.status.value !== 'building') void readAlong.fetchExisting(props.book.id)
  if (canGenerate.value) readAlongSection.loadTargetLibraries()
}

function handleKeepRemoteCopy(value: boolean) {
  readAlong.setKeepRemoteCopy(value)
}
</script>

<template>
  <Popover v-if="checked && visible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        data-testid="alignment-trigger"
      >
        <component :is="statusIcon" class="size-3.5" :class="statusIconClass" />
        {{ statusLabel }}
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="max-h-(--reka-popover-content-available-height) w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-4"
    >
      <PositionSyncSection
        class="mt-0!"
        :status="alignment.status.value"
        :samples-done="alignment.samplesDone.value"
        :samples-total="alignment.samplesTotal.value"
        :built-at="alignment.builtAt.value"
        :build-blocked="alignment.buildBlocked.value"
        :mutating="alignment.mutating.value"
        :can-build="canEditMetadata"
        :counterpart-modality="counterpartModality"
        :counterpart-title="counterpartTitle"
        @build="handleBuild"
      />

      <ReadAlongSection
        v-if="showReadAlongSection"
        mode="manage"
        :state="readAlongSection.sectionState.value"
        :member="readAlongMember"
        :can-generate="canGenerate"
        :can-rebuild="readAlongSection.canRebuild.value"
        :existing-match="readAlongSection.existingMatch.value"
        :keep-copy-offered="readAlongSection.keepCopyOffered.value"
        :target-libraries="readAlongSection.targetLibraries.value"
        :chosen-target-library-id="readAlongSection.chosenTargetLibraryId.value"
        :target-library-name="readAlongSection.targetLibraryName.value"
        @update:keep-remote-copy="handleKeepRemoteCopy"
        @update:target-library-id="readAlongSection.setTargetLibrary"
        @generate="readAlongSection.handleGenerate"
        @import-existing="readAlongSection.handleImportExisting"
        @retry="readAlongSection.handleRetry"
        @cancel="readAlongSection.handleCancel"
        @rebuild="readAlongSection.handleRebuild"
      />
    </PopoverContent>
  </Popover>
</template>
