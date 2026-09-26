import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Permission, type ReadAlongBuildRequest, type StorytellerExistingMatch } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { isReadAlongTargetLibrary } from '@/features/storyteller/lib/read-along-libraries'
import { useReadAlong, type ReadAlongSectionState } from './useReadAlong'

/**
 * Everything a host of ReadAlongSection needs on top of the raw state: the props the section reads,
 * the permissions its actions are gated on, the destination choice, and the build runner that
 * narrates the outcomes the section cannot show by itself. Both hosts (the Link edition panel and the
 * Reading Log position sync popover) mount one section each, so none of this belongs in either.
 */
export function useReadAlongSection(bookId: () => number) {
  const { t } = useI18n()
  const { hasPermission } = usePermissions()
  const readAlong = useReadAlong()
  const { libraries, fetchLibraries } = useLibraries()

  const canGenerate = computed(() => hasPermission(Permission.LibraryUpload))
  /** Replacing an output means deleting it, which the build endpoint holds to LibraryDeleteBooks. */
  const canRebuild = computed(() => hasPermission(Permission.LibraryDeleteBooks))

  const sectionState = computed<ReadAlongSectionState>(() => ({
    status: readAlong.status.value,
    blocked: readAlong.blocked.value,
    phase: readAlong.phase.value,
    transport: readAlong.transport.value,
    remoteTask: readAlong.remoteTask.value,
    remoteProgress: readAlong.remoteProgress.value,
    targetLibraryName: readAlong.targetLibraryName.value,
    remoteCopyBytes: readAlong.remoteCopyBytes.value,
    keepRemoteCopy: readAlong.keepRemoteCopy.value,
    remoteCopyReclaimable: readAlong.remoteCopyReclaimable.value,
    hasOutputBook: readAlong.outputBook.value !== null,
    error: readAlong.error.value,
    mutating: readAlong.mutating.value,
  }))

  const existingMatch = computed<StorytellerExistingMatch | null>(() => readAlong.existingMatches.value.find((match) => match.aligned) ?? null)

  // So the select can never offer a destination the build endpoint would refuse.
  const targetLibraries = computed(() => libraries.value.filter(isReadAlongTargetLibrary))

  // Only what the user picked in this visit. The destination line falls back to the library the server
  // would pick anyway, but that fallback is a description, not a choice, so the select and the build
  // request both read this instead.
  const chosenTargetLibraryId = ref<number | null>(null)
  const targetLibraryName = computed(() => {
    if (chosenTargetLibraryId.value === null) return readAlong.targetLibraryName.value
    return targetLibraries.value.find((library) => library.id === chosenTargetLibraryId.value)?.name ?? null
  })

  // The server answers reclaimability for the configured destination only. Picking a different library
  // makes that answer someone else's, so the choice is offered again rather than hidden.
  const keepCopyOffered = computed(() => readAlong.remoteCopyReclaimable.value || chosenTargetLibraryId.value !== null)

  function setTargetLibrary(id: number | null): void {
    chosenTargetLibraryId.value = id
  }

  function loadTargetLibraries(): void {
    void fetchLibraries()
  }

  /** Drops the per-visit destination and keep-copy choices, for a visit that starts over. */
  function resetChoices(): void {
    chosenTargetLibraryId.value = null
    readAlong.resetKeepRemoteCopy()
  }

  // Only what the user actually picked. Sending the displayed default back reads to the server as "the
  // caller chose a destination", which drops the configured target folder and lands the build in the
  // library's lowest-id folder, possibly outside the mapped read-aloud location.
  function withDestination(request: ReadAlongBuildRequest): ReadAlongBuildRequest {
    const chosen = chosenTargetLibraryId.value
    return chosen === null ? request : { ...request, targetLibraryId: chosen }
  }

  // A build that starts is narrated by the section, and a refused one by its block message. The two
  // that leave the section as it was have to be said out loud, or the click reads as having done nothing.
  async function runBuild(request: ReadAlongBuildRequest): Promise<void> {
    const outcome = await readAlong.build(bookId(), request)
    if (outcome === 'failed') toast.error(t('book.detail.editionLink.readAlong.buildFailed'))
    else if (outcome === 'ready') toast.info(t('book.detail.editionLink.readAlong.buildAlreadyReady'))
  }

  function handleGenerate(): void {
    void runBuild(withDestination({}))
  }

  // A failed build resumes from its last phase, so it must not force: only a deliberate rebuild
  // replaces an output that already exists.
  function handleRetry(): void {
    void runBuild(withDestination({}))
  }

  function handleRebuild(): void {
    void runBuild(withDestination({ force: true }))
  }

  async function handleCancel(): Promise<void> {
    const outcome = await readAlong.cancel(bookId())
    if (outcome === 'too_late') toast.error(t('book.detail.editionLink.readAlong.cancelTooLate'))
    else if (outcome === 'failed') toast.error(t('book.detail.editionLink.readAlong.cancelUnavailable'))
  }

  function handleImportExisting(uuid: string): void {
    void runBuild(withDestination({ useExistingUuid: uuid }))
  }

  return {
    readAlong,
    canGenerate,
    canRebuild,
    sectionState,
    existingMatch,
    targetLibraries,
    chosenTargetLibraryId,
    targetLibraryName,
    keepCopyOffered,
    setTargetLibrary,
    loadTargetLibraries,
    resetChoices,
    withDestination,
    runBuild,
    handleGenerate,
    handleRetry,
    handleRebuild,
    handleCancel,
    handleImportExisting,
  }
}
