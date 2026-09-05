import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_FORMATS, type MonitoredFormat, type ReleaseCandidateItem } from '@bookorbit/types'

import { grabWorkRelease, searchWorkReleases } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'

/**
 * Monitored release search and grab, wired to the Requests fulfilment pipeline. The server
 * materializes (or reuses) a book request for the work+format and delegates to the same
 * search/grab flow "Requests (Beta)" uses, so results, scoring and download behavior are
 * identical between the two surfaces. The panel consumes only the returned state and the two
 * actions, so it never needs to change.
 */
export function useMonitoredReleases(workId: Ref<string | null>, format: MonitoredFormat) {
  const { t } = useI18n()
  const releases = ref<ReleaseCandidateItem[]>([])
  const loading = ref(false)
  const searched = ref(false)
  const error = ref<string | null>(null)
  const grabbing = ref(new Set<string>())
  // Survives the grab so the row it was clicked on stays settled while the panel is still open.
  const grabbed = ref(new Set<string>())
  // Indexer searches are slow enough that a response can land after the panel moved to another
  // work, so every search claims a generation and only the newest one may write state.
  let generation = 0

  async function search(): Promise<void> {
    const requestedWorkId = workId.value
    if (requestedWorkId === null) return
    if (!MONITORED_FORMATS.includes(format)) {
      error.value = t('monitored.errors.unsupportedFormat')
      return
    }

    const token = ++generation
    loading.value = true
    error.value = null
    try {
      const result = await searchWorkReleases(requestedWorkId, format)
      if (token !== generation || workId.value !== requestedWorkId) return
      releases.value = result.releases
      searched.value = true
      // An empty list with zero enabled indexers is a configuration state, not a search result.
      if (result.enabledIndexerCount === 0) {
        error.value = t('monitored.errors.noIndexers')
      }
    } catch (cause) {
      if (token !== generation || workId.value !== requestedWorkId) return
      releases.value = []
      searched.value = true
      error.value = monitoredErrorText(cause, t('monitored.errors.searchFailed'))
    } finally {
      if (token === generation) loading.value = false
    }
  }

  /**
   * One composable instance serves every work the panel visits, so an in-flight marker has to name
   * the work it belongs to. A bare guid would let a settling grab clear a newer work's marker.
   */
  function grabKey(forWorkId: string, release: ReleaseCandidateItem): string {
    return `${forWorkId}:${format}:${release.indexerId}:${release.guid}`
  }

  function isGrabbing(release: ReleaseCandidateItem): boolean {
    const currentWorkId = workId.value
    if (currentWorkId === null || !release.guid) return false
    return grabbing.value.has(grabKey(currentWorkId, release))
  }

  function isGrabbed(release: ReleaseCandidateItem): boolean {
    const currentWorkId = workId.value
    if (currentWorkId === null || !release.guid) return false
    return grabbed.value.has(grabKey(currentWorkId, release))
  }

  /** Resolves to the book request the download runs under, or null when nothing was queued. */
  async function grab(release: ReleaseCandidateItem): Promise<number | null> {
    const releaseGuid = release.guid
    if (!releaseGuid) {
      error.value = t('monitored.errors.missingReleaseId')
      return null
    }
    const requestedWorkId = workId.value
    if (requestedWorkId === null) return null

    // A second click while the first grab is in flight would queue the same download twice.
    const key = grabKey(requestedWorkId, release)
    if (grabbing.value.has(key)) return null

    grabbing.value = new Set([...grabbing.value, key])
    error.value = null
    try {
      const request = await grabWorkRelease(requestedWorkId, { format, indexerId: release.indexerId, releaseGuid })
      grabbed.value = new Set([...grabbed.value, key])
      return request.id
    } catch (cause) {
      // The panel may have moved on; a stale failure must not land on the work now on screen.
      if (workId.value === requestedWorkId) error.value = monitoredErrorText(cause, t('monitored.errors.grabFailed'))
      return null
    } finally {
      const next = new Set(grabbing.value)
      next.delete(key)
      grabbing.value = next
    }
  }

  return { releases, loading, searched, error, isGrabbing, isGrabbed, search, grab }
}
