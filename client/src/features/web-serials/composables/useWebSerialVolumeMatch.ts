import { onScopeDispose } from 'vue'
import { useMetadataSearch } from '@/features/book/composables/useMetadataSearch'
import type { MetadataCandidate, MetadataProviderKey } from '@bookorbit/types'
import { pickVolumeCandidate, volumeSearchQueries, type VolumeCandidatePick } from '../lib/publishedVolumeMatch'
import type { PublishedSeries } from '../lib/publishedVolumes'

/**
 * A provider stream still open by then is no longer waited on: the volume is judged on what arrived,
 * and the next search, which aborts the shared stream, closes it.
 */
export const VOLUME_QUERY_TIMEOUT_MS = 20_000

/**
 * Resolves one published volume to a real book through the same provider search the Requests page
 * uses, so a request carries the published title, ISBN and provider id instead of free text.
 */
export function useWebSerialVolumeMatch() {
  const { results, providers, loadProviders, search } = useMetadataSearch()
  let providersLoaded: Promise<void> | null = null
  let disposed = false
  // The shared search aborts and clears its results on every call, so overlapping volumes take turns.
  let queue: Promise<unknown> = Promise.resolve()

  function ensureProviders(): Promise<void> {
    providersLoaded ??= loadProviders().then(
      () => undefined,
      (cause: unknown) => {
        providersLoaded = null
        throw cause
      },
    )
    return providersLoaded
  }

  onScopeDispose(() => {
    disposed = true
  })

  async function searchWithTimeout(params: Parameters<typeof search>[0]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, VOLUME_QUERY_TIMEOUT_MS)
    })
    try {
      await Promise.race([search(params), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The label the Requests page would show next to a provider's record. */
  function providerLabel(provider: MetadataProviderKey): string {
    return providers.value.find((entry) => entry.key === provider)?.label ?? provider
  }

  /**
   * Runs the volume's queries in order and stops at the first one whose results contain the volume.
   * The remaining queries are fallbacks for a title the providers do not know, not extra chances to
   * find a better record of one they do.
   */
  function resolveVolume(series: PublishedSeries, volume: number): Promise<VolumeCandidatePick | null> {
    const run = queue.then(() => resolveNow(series, volume))
    queue = run.catch(() => undefined)
    return run
  }

  async function resolveNow(series: PublishedSeries, volume: number): Promise<VolumeCandidatePick | null> {
    if (disposed) return null
    await ensureProviders()
    const accumulated: MetadataCandidate[] = []
    const seen = new Set<string>()
    let pick: VolumeCandidatePick | null = null
    for (const query of volumeSearchQueries(series, volume)) {
      if (disposed) return null
      await searchWithTimeout({ title: query.title, ...(query.author ? { author: query.author } : {}), mediaKind: 'ebook' })
      if (disposed) return null
      for (const candidate of results.value) {
        const key = `${candidate.provider}:${candidate.providerId}`
        if (seen.has(key)) continue
        seen.add(key)
        accumulated.push(candidate)
      }
      pick = pickVolumeCandidate(accumulated, series, volume)
      if (pick) return pick
    }
    return pick
  }

  return { resolveVolume, providerLabel }
}
