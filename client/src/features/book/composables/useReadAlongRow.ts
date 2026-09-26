import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Permission, type ReadAlongBuildRequest, type StorytellerExistingMatch } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useReadAlong, type ReadAlongRowState } from './useReadAlong'

/**
 * Everything a host of ReadAlongMemberRow needs on top of the raw state: the props the row reads,
 * the permissions its actions are gated on, and the build runner that narrates the outcomes the row
 * cannot show by itself. Both hosts (the Link popover for a linked pair, the alignment popover for a
 * self-pair) mount one row each, so none of this belongs in either component.
 *
 * What stays with the host is what genuinely differs between them: which book the row is titled
 * after (an edition-link member for a linked pair, the build's own output book for a self-pair),
 * and the Link popover's generate-on-link tick box with its destination select.
 */
export function useReadAlongRow(bookId: () => number) {
  const { t } = useI18n()
  const { hasPermission } = usePermissions()
  const readAlong = useReadAlong()

  const canGenerate = computed(() => hasPermission(Permission.LibraryUpload))
  /** Replacing an output means deleting it, which the build endpoint holds to LibraryDeleteBooks. */
  const canRebuild = computed(() => hasPermission(Permission.LibraryDeleteBooks))

  const rowState = computed<ReadAlongRowState>(() => ({
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

  // A build that starts is narrated by the row, and a refused one by its block message. The two that
  // leave the row as it was have to be said out loud, or the click reads as having done nothing.
  async function runBuild(request: ReadAlongBuildRequest): Promise<void> {
    const outcome = await readAlong.build(bookId(), request)
    if (outcome === 'failed') toast.error(t('book.detail.editionLink.readAlong.buildFailed'))
    else if (outcome === 'ready') toast.info(t('book.detail.editionLink.readAlong.buildAlreadyReady'))
  }

  function handleGenerate(): void {
    void runBuild({})
  }

  // A failed build resumes from its last phase, so it must not force: only a deliberate rebuild
  // replaces an output that already exists.
  function handleRetry(): void {
    void runBuild({})
  }

  function handleRebuild(): void {
    void runBuild({ force: true })
  }

  function handleImportExisting(uuid: string): void {
    void runBuild({ useExistingUuid: uuid })
  }

  return {
    readAlong,
    canGenerate,
    canRebuild,
    rowState,
    existingMatch,
    runBuild,
    handleGenerate,
    handleRetry,
    handleRebuild,
    handleImportExisting,
  }
}
