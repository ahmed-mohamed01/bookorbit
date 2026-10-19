import { onScopeDispose } from 'vue'
import type { ReleaseCandidateItem, ReleaseFileInspection } from '@bookorbit/types'

export function useBackgroundInspection(options: {
  inspect: (release: ReleaseCandidateItem) => Promise<ReleaseFileInspection | null>
  concurrency?: number
}) {
  const limit = Math.min(2, Math.max(1, Math.floor(options.concurrency ?? 2) || 2))
  const rows = new Map<Element, ReleaseCandidateItem>()
  const seen = new Set<string>()
  const queue = new Map<string, ReleaseCandidateItem>()
  let active = 0
  let disposed = false

  function drain(): void {
    while (!disposed && active < limit && queue.size) {
      const [key, release] = queue.entries().next().value!
      queue.delete(key)
      active++
      void Promise.resolve()
        .then(() => options.inspect(release))
        .catch(() => null)
        .finally(() => {
          active--
          drain()
        })
    }
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const release = rows.get(entry.target)
      if (!release?.inspectionWanted) continue
      if (!entry.isIntersecting) {
        const key = `${release.indexerId}:${release.guid}`
        if (queue.delete(key)) seen.delete(key)
        continue
      }
      const key = `${release.indexerId}:${release.guid}`
      if (seen.has(key)) continue
      seen.add(key)
      queue.set(key, release)
    }
    drain()
  })

  function observe(el: Element, release: ReleaseCandidateItem): void {
    rows.set(el, release)
    if (release.inspectionWanted) observer.observe(el)
    else observer.unobserve(el)
  }

  function unobserve(el: Element): void {
    const release = rows.get(el)
    rows.delete(el)
    observer.unobserve(el)
    if (release && ![...rows.values()].some((row) => row.indexerId === release.indexerId && row.guid === release.guid)) {
      const key = `${release.indexerId}:${release.guid}`
      if (queue.delete(key)) seen.delete(key)
    }
  }

  function reset(): void {
    seen.clear()
    queue.clear()
    for (const [el, release] of rows) {
      observer.unobserve(el)
      if (release.inspectionWanted) observer.observe(el)
    }
  }

  onScopeDispose(() => {
    disposed = true
    observer.disconnect()
    rows.clear()
    queue.clear()
    seen.clear()
  })

  return { observe, unobserve, reset }
}
