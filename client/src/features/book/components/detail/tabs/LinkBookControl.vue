<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, ChevronDown, Headphones, Info, Link2, Loader2, Search, Unlink2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Permission, type BookDetail, type EditionLinkMember, type ReadAlongBlockReason } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isReadAlongTargetLibrary } from '@/features/storyteller/lib/read-along-libraries'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { getBookLinkModality, useEditionLink, type EditionLinkCandidate } from '@/features/book/composables/useEditionLink'
import { useReadingAlignment } from '@/features/book/composables/useReadingAlignment'
import { useReadAlongRow } from '@/features/book/composables/useReadAlongRow'
import { readAlongKeepCopyHint } from '@/features/book/lib/read-along-copy-hint'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ReadAlongMemberRow from './ReadAlongMemberRow.vue'

const props = withDefaults(defineProps<{ book: BookDetail; triggerClass?: string }>(), {
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})

const { t } = useI18n()
const generateLabelId = `read-along-on-link-${useId()}`
const keepCopyLabelId = `read-along-on-link-keep-copy-${useId()}`

// Blockers that make ticking the box pointless: they can only be cleared in the Storyteller settings,
// never by retrying. 'busy' and the pair-shaped reasons stay tickable, since linking is what creates
// the pair in the first place.
const TICK_BLOCK_REASONS = new Set<ReadAlongBlockReason>([
  'not_configured',
  'unreachable',
  'no_target_library',
  'target_not_allowed',
  'format_not_allowed',
])

const modality = computed(() => getBookLinkModality(props.book.files))

const alignment = useReadingAlignment()
const { readAlong, canGenerate, canRebuild, rowState, existingMatch, runBuild, handleGenerate, handleRetry, handleRebuild, handleImportExisting } =
  useReadAlongRow(() => props.book.id)

const { hasPermission } = usePermissions()
const canEditMetadata = computed(() => hasPermission(Permission.LibraryEditMetadata))

// A read-along is built from a pair, so offering to generate one before there is anything to link
// with is an option that cannot be taken. Until a candidate exists, say what is missing instead.
const hasLinkCandidate = computed(() => proposed.value !== null || candidates.value.length > 0)

const { libraries, fetchLibraries } = useLibraries()
// So the select can never offer a destination the build endpoint would refuse.
const targetLibraries = computed(() => libraries.value.filter(isReadAlongTargetLibrary))

const {
  link,
  proposed,
  role,
  members,
  candidates,
  loading,
  searching,
  mutating,
  error,
  searchError,
  loadForBook,
  searchCandidates,
  linkBook,
  unlink: unlinkBook,
  resetSearch,
} = useEditionLink(props.book.id)

// The read-along book is a member of the link, so its own page shows the membership - read only,
// with no link, unlink or search actions: it can never start or end a link of its own.
const isReadAlongMember = computed(() => role.value === 'readAlong')
const isEligible = computed(() => modality.value === 'text' || modality.value === 'audio' || isReadAlongMember.value)

// The counterpart is always the opposite modality of the current book, and every candidate shares
// it, so a single indicator describes what we are linking to.
const counterpartIsAudio = computed(() => modality.value === 'text')
const counterpartLabel = computed(() =>
  counterpartIsAudio.value ? t('book.detail.editionLink.counterpartAudiobook') : t('book.detail.editionLink.counterpartEbook'),
)
const counterpartIcon = computed(() => (counterpartIsAudio.value ? Headphones : BookOpen))

const readAlongMember = computed(() => members.value?.readAlong ?? null)

// The server answers reclaimability for the configured destination, which is the only one it can
// resolve. Picking a different library here makes that answer someone else's, so the choice is
// offered again rather than hidden on the strength of a library this build will not use.
const keepCopyApplies = computed(() => !readAlong.remoteCopyReclaimable.value && chosenTargetLibraryId.value === null)

const keepCopyHint = computed(() => readAlongKeepCopyHint(readAlong.remoteCopyBytes.value, readAlong.transport.value !== null, t))

function memberProgressLabel(member: EditionLinkMember, spoken: boolean): string | null {
  const percentage = member.progress?.percentage
  if (typeof percentage !== 'number') return null
  const params = { percentage: Math.round(percentage) }
  return spoken ? t('book.detail.editionLink.readAlong.progressListened', params) : t('book.detail.editionLink.readAlong.progressRead', params)
}

const sourceMembers = computed(() => {
  const resolved = members.value
  if (!resolved) return []
  return [
    {
      key: 'text' as const,
      icon: BookOpen,
      label: t('book.detail.editionLink.counterpartEbook'),
      member: resolved.text,
      progress: memberProgressLabel(resolved.text, false),
    },
    {
      key: 'audio' as const,
      icon: Headphones,
      label: t('book.detail.editionLink.counterpartAudiobook'),
      member: resolved.audio,
      progress: memberProgressLabel(resolved.audio, true),
    },
  ]
})

function memberRoute(bookId: number) {
  return { name: 'book-detail', params: { bookId } }
}

function isCurrentBook(bookId: number): boolean {
  return bookId === props.book.id
}

const linkedHeading = computed(() =>
  isReadAlongMember.value ? t('book.detail.editionLink.readAlong.readOnlyTitle') : t('book.detail.editionLink.readAlong.membersTitle'),
)

const alignmentStatusLabel = computed(() => t(`book.detail.readingAlignment.status.${alignment.status.value}`))

const alignmentBusy = computed(() => alignment.mutating.value || alignment.status.value === 'building' || alignment.status.value === 'pending')
const readAlongBusy = computed(() => readAlong.mutating.value || readAlong.status.value === 'building')

// The trigger icon narrates the match lifecycle: blue while either build is processing, green once
// the pair is linked and aligned, red when a build failed, the default linked accent otherwise.
const iconClass = computed(() => {
  if (!link.value) return ''
  if (alignmentBusy.value || readAlongBusy.value) return 'text-sky-500'
  if (readAlong.status.value === 'failed' || alignment.status.value === 'failed') return 'text-destructive'
  if (alignment.status.value === 'ready') return 'text-emerald-500'
  return 'text-primary'
})

const linkTooltip = computed(() => {
  if (!link.value) {
    return modality.value === 'audio' ? t('book.detail.editionLink.tooltipNeedsText') : t('book.detail.editionLink.tooltipNeedsAudio')
  }
  if (readAlongBusy.value) return t('book.detail.editionLink.tooltipReadAlongBuilding')
  if (alignmentBusy.value) return t('book.detail.editionLink.tooltipAligning')
  if (readAlong.status.value === 'failed') return t('book.detail.editionLink.tooltipReadAlongFailed')
  if (alignment.status.value === 'ready') return t('book.detail.editionLink.tooltipAligned')
  if (alignment.status.value === 'failed') return t('book.detail.editionLink.tooltipAlignFailed')
  return t('book.detail.editionLink.tooltipLinked')
})

// Deliberately per book and per visit: a read-along is hours of CPU and hundreds of MB, so it is
// asked for each time rather than carried over from some earlier link.
const readAlongOnLink = ref(false)

const chosenTargetLibraryId = ref<number | null>(null)
// What the select displays, which falls back to the library the server would pick anyway so the real
// destination is on screen before the user touches it. The build request is sent from
// `chosenTargetLibraryId` instead: this fallback is a description, not a choice.
const targetLibraryId = computed({
  get: () => chosenTargetLibraryId.value ?? readAlong.targetLibraryId.value,
  set: (value: number | null) => {
    chosenTargetLibraryId.value = value
  },
})

const tickBlockReason = computed(() => {
  const blocked = readAlong.blocked.value
  return blocked && TICK_BLOCK_REASONS.has(blocked) ? blocked : null
})

const readAlongTickDisabled = computed(() => !canGenerate.value || tickBlockReason.value !== null)

const tickHint = computed(() => {
  switch (tickBlockReason.value) {
    case 'not_configured':
      return t('book.detail.editionLink.readAlong.blocked.notConfigured')
    case 'unreachable':
      return t('book.detail.editionLink.readAlong.blocked.unreachable')
    case 'no_target_library':
      return t('book.detail.editionLink.readAlong.blocked.noTargetLibrary')
    case 'target_not_allowed':
      return t('book.detail.editionLink.readAlong.blocked.targetNotAllowed')
    case 'format_not_allowed':
      return t('book.detail.editionLink.readAlong.blocked.formatNotAllowed')
    default:
      return t('book.detail.editionLink.readAlong.generateOnLinkHint')
  }
})

// Read up front so the trigger's hover title reflects the real state before the popover is ever
// opened. One cheap fetch per book-detail view; the popover refreshes it on open.
function refreshBuildStatuses() {
  if (!link.value) return
  void alignment.fetchStatus(props.book.id)
  void readAlong.fetchStatus(props.book.id)
}

onMounted(() => {
  if (!isEligible.value) return
  void loadForBook().then(refreshBuildStatuses)
})

// A finished build adds the third member, which only the for-book response knows about.
readAlong.onReady(() => {
  void loadForBook()
})

const open = ref(false)
const searchOpen = ref(false)
const hasSearched = ref(false)
const query = ref('')

async function handleOpenChange(next: boolean) {
  open.value = next
  if (!next) return

  searchOpen.value = false
  hasSearched.value = false
  query.value = ''
  resetSearch()
  // Ticking the box, closing without linking and reopening on a different candidate would otherwise
  // start an hours-long build nobody re-confirmed. The destination and the keep-copy choice only mean
  // anything alongside the tick, so they are dropped with it.
  readAlongOnLink.value = false
  chosenTargetLibraryId.value = null
  readAlong.resetKeepRemoteCopy()

  await loadForBook()
  if (link.value) {
    void alignment.fetchStatus(props.book.id)
    void readAlong.fetchStatus(props.book.id)
    // An aligned Storyteller book that already covers this pair can be imported instead of rebuilt.
    if (canGenerate.value && !isReadAlongMember.value && !readAlongMember.value) void readAlong.fetchExisting(props.book.id)
  } else if (canGenerate.value) {
    // Read on an unlinked book too: the tick box has to know whether Storyteller is usable at all,
    // and the options row needs somewhere to send the output.
    void readAlong.fetchStatus(props.book.id)
    void fetchLibraries()
  }
  if (canEditMetadata.value && !link.value && !proposed.value) {
    searchOpen.value = true
    hasSearched.value = true
    void searchCandidates('')
  }
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value && !hasSearched.value) {
    hasSearched.value = true
    void searchCandidates(query.value)
  }
}

function handleQueryInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
  hasSearched.value = true
  void searchCandidates(query.value)
}

function handleKeepRemoteCopyOnLink(value: boolean) {
  readAlong.setKeepRemoteCopy(value)
}

async function confirmLink(counterpartId: number) {
  const success = await linkBook(counterpartId)
  if (!success) {
    toast.error(error.value ?? t('book.detail.editionLink.linkFailed'))
    return
  }
  toast.success(t('book.detail.editionLink.linkedSuccess'))
  searchOpen.value = false
  query.value = ''
  // Matching flows straight into alignment: kick the build off so the icon can narrate
  // blue (processing) -> green (linked and aligned) without a separate manual step.
  void alignment.build(props.book.id)
  if (!readAlongOnLink.value || readAlongTickDisabled.value) return
  // Only what the user actually picked. The select shows the configured default, but sending it back
  // reads to the server as "the caller chose a destination", which drops the configured target folder
  // and lands the build in the library's lowest-id folder - possibly outside the mapped read-aloud
  // location, which silently downgrades the transport to uploading the whole audiobook.
  const chosen = chosenTargetLibraryId.value
  void runBuild(chosen === null ? {} : { targetLibraryId: chosen })
}

function handleProposedLinkClick() {
  if (proposed.value) void confirmLink(proposed.value.bookId)
}

function selectCandidate(candidate: EditionLinkCandidate) {
  void confirmLink(candidate.bookId)
}

async function handleUnlinkClick() {
  const success = await unlinkBook()
  if (success) {
    toast.success(t('book.detail.editionLink.unlinkedSuccess'))
  } else {
    toast.error(error.value ?? t('book.detail.editionLink.unlinkFailed'))
  }
}
</script>

<template>
  <Popover v-if="isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button type="button" :class="triggerClass" :title="linkTooltip" :aria-label="t('book.detail.editionLink.trigger')">
        <Link2 class="size-3.5" :class="iconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 max-w-[calc(100vw-2rem)] p-3">
      <p class="text-sm font-semibold text-foreground">{{ t('book.detail.editionLink.title') }}</p>

      <div v-if="loading" class="mt-3 space-y-2">
        <div class="h-4 w-3/4 rounded bg-muted animate-shimmer" />
        <div class="h-8 w-full rounded bg-muted animate-shimmer" />
      </div>

      <template v-else>
        <div v-if="link" class="mt-3" data-testid="edition-link-linked">
          <p class="text-xs text-muted-foreground">{{ linkedHeading }}</p>

          <div class="mt-1.5 space-y-2">
            <div
              v-for="row in sourceMembers"
              :key="row.key"
              class="flex items-start gap-2 rounded-lg border border-border bg-background p-2.5"
              :data-testid="`edition-link-member-${row.key}`"
            >
              <component :is="row.icon" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" :aria-label="row.label" />
              <div class="min-w-0 flex-1">
                <p class="text-[11px] text-muted-foreground">{{ row.label }}</p>
                <p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                  <RouterLink :to="memberRoute(row.member.id)" class="truncate hover:underline">
                    {{ row.member.title ?? t('book.detail.editionLink.unknownTitle') }}
                  </RouterLink>
                  <span
                    v-if="isCurrentBook(row.member.id)"
                    class="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
                    data-testid="edition-link-this-book"
                  >
                    {{ t('book.detail.editionLink.readAlong.thisBook') }}
                  </span>
                </p>
                <p v-if="row.member.authorName" class="truncate text-xs text-muted-foreground">{{ row.member.authorName }}</p>
                <p v-if="row.progress" class="text-xs text-muted-foreground">{{ row.progress }}</p>
              </div>
            </div>

            <ReadAlongMemberRow
              v-if="!isReadAlongMember"
              :state="rowState"
              :member="readAlongMember"
              :can-generate="canGenerate"
              :can-rebuild="canRebuild"
              :existing-match="existingMatch"
              :is-current-book="readAlongMember ? isCurrentBook(readAlongMember.id) : false"
              @update:keep-remote-copy="readAlong.setKeepRemoteCopy"
              @generate="handleGenerate"
              @import-existing="handleImportExisting"
              @retry="handleRetry"
              @rebuild="handleRebuild"
            />
          </div>

          <p class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="edition-link-alignment-status">
            <span>{{ t('book.detail.readingAlignment.title') }}</span>
            <span class="text-foreground">{{ alignmentStatusLabel }}</span>
          </p>

          <template v-if="canEditMetadata && !isReadAlongMember">
            <button
              type="button"
              class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="mutating"
              data-testid="edition-link-unlink"
              @click="handleUnlinkClick"
            >
              <Loader2 v-if="mutating" class="size-3.5 animate-spin" />
              <Unlink2 v-else class="size-3.5" />
              {{ t('book.detail.editionLink.unlink') }}
            </button>
            <p v-if="readAlongMember" class="mt-1 text-[11px] text-muted-foreground">{{ t('book.detail.editionLink.readAlong.unlinkNote') }}</p>
          </template>
        </div>

        <template v-else>
          <div v-if="proposed" class="mt-3 rounded-lg border border-border bg-background p-2.5" data-testid="edition-link-proposed">
            <p class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.suggestedMatch') }}</p>
            <p class="mt-0.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
              <span class="truncate">{{ proposed.title ?? t('book.detail.editionLink.unknownTitle') }}</span>
              <component
                :is="counterpartIcon"
                class="size-3.5 shrink-0 text-muted-foreground"
                :aria-label="counterpartLabel"
                data-testid="edition-link-counterpart-format"
              />
            </p>
            <p v-if="proposed.authorName" class="truncate text-xs text-muted-foreground">{{ proposed.authorName }}</p>
            <p class="mt-1 text-[11px] text-muted-foreground">{{ t('book.detail.editionLink.confidence', { score: proposed.score }) }}</p>
            <button
              v-if="canEditMetadata"
              type="button"
              class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="mutating"
              @click="handleProposedLinkClick"
            >
              <Loader2 v-if="mutating" class="size-3.5 animate-spin" />
              <Link2 v-else class="size-3.5" />
              {{ t('book.detail.editionLink.confirmLink') }}
            </button>
          </div>
          <p v-else class="mt-3 text-xs text-muted-foreground" data-testid="edition-link-no-match">{{ t('book.detail.editionLink.noMatch') }}</p>

          <p
            v-if="canEditMetadata && canGenerate && !hasLinkCandidate"
            class="mt-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground"
            data-testid="read-along-needs-counterpart"
          >
            {{ t('book.detail.editionLink.readAlong.needsCounterpart', { counterpart: counterpartLabel.toLowerCase() }) }}
          </p>

          <div
            v-if="canEditMetadata && canGenerate && hasLinkCandidate"
            class="mt-2 rounded-lg border border-border bg-background p-2.5"
            data-testid="read-along-on-link"
          >
            <div class="flex items-center gap-2 text-xs font-medium text-foreground">
              <ToggleSwitch
                v-model="readAlongOnLink"
                :disabled="readAlongTickDisabled"
                :aria-labelledby="generateLabelId"
                data-testid="read-along-on-link-checkbox"
              />
              <span :id="generateLabelId">{{ t('book.detail.editionLink.readAlong.generate') }}</span>
            </div>
            <p class="mt-1 text-[11px] text-muted-foreground" data-testid="read-along-on-link-hint">{{ tickHint }}</p>

            <div v-if="readAlongOnLink && !readAlongTickDisabled" class="mt-2" data-testid="read-along-on-link-options">
              <label class="block text-[11px] text-muted-foreground" for="read-along-target-library">
                {{ t('book.detail.editionLink.readAlong.targetLibrary') }}
              </label>
              <select
                id="read-along-target-library"
                v-model="targetLibraryId"
                class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              >
                <option :value="null">{{ t('book.detail.editionLink.readAlong.targetLibraryPlaceholder') }}</option>
                <option v-for="library in targetLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
              </select>

              <p v-if="keepCopyApplies" class="mt-2 text-[11px] text-muted-foreground" data-testid="read-along-on-link-keep-copy-moot">
                {{ t('book.detail.editionLink.readAlong.keepCopy.notApplicable') }}
              </p>
              <div v-else class="mt-2 flex items-center gap-1.5">
                <ToggleSwitch
                  :model-value="readAlong.keepRemoteCopy.value"
                  :disabled="readAlong.mutating.value"
                  :aria-labelledby="keepCopyLabelId"
                  data-testid="read-along-on-link-keep-copy"
                  @update:model-value="handleKeepRemoteCopyOnLink"
                />
                <span :id="keepCopyLabelId" class="text-[11px] text-muted-foreground">
                  {{ t('book.detail.editionLink.readAlong.keepCopy.label') }}
                </span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      class="text-muted-foreground transition-colors hover:text-foreground"
                      :aria-label="keepCopyHint"
                      data-testid="read-along-on-link-keep-copy-hint"
                    >
                      <Info class="size-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent class="max-w-72">{{ keepCopyHint }}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>

          <div v-if="canEditMetadata" class="mt-3 border-t border-border pt-3">
            <button
              type="button"
              class="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              @click="toggleSearch"
            >
              <span class="inline-flex items-center gap-1.5"><Search class="size-3.5" />{{ t('book.detail.editionLink.searchToggle') }}</span>
              <ChevronDown class="size-3.5 transition-transform" :class="{ 'rotate-180': searchOpen }" />
            </button>

            <div v-if="searchOpen" class="mt-2 space-y-2" data-testid="edition-link-search">
              <input
                type="text"
                :value="query"
                class="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                :placeholder="t('book.detail.editionLink.searchPlaceholder')"
                @input="handleQueryInput"
              />
              <p v-if="searching" class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.searching') }}</p>
              <p v-else-if="searchError" class="text-xs text-destructive" data-testid="edition-link-search-error">
                {{ t('book.detail.editionLink.searchFailed') }}
              </p>
              <ul v-else-if="candidates.length" class="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                <li v-for="candidate in candidates" :key="candidate.bookId">
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="mutating"
                    @click="selectCandidate(candidate)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center gap-1.5 text-foreground">
                        <span class="truncate">{{ candidate.title ?? t('book.detail.editionLink.unknownTitle') }}</span>
                        <component :is="counterpartIcon" class="size-3 shrink-0 text-muted-foreground" :aria-label="counterpartLabel" />
                      </span>
                      <span v-if="candidate.authorName" class="block truncate text-xs text-muted-foreground">{{ candidate.authorName }}</span>
                    </span>
                    <span class="shrink-0 text-[11px] text-muted-foreground">{{ candidate.score }}%</span>
                  </button>
                </li>
              </ul>
              <p v-else-if="hasSearched" class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.noResults') }}</p>
            </div>
          </div>
        </template>
      </template>
    </PopoverContent>
  </Popover>
</template>
