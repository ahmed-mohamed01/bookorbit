const MONITORED_COVER_PATH = '/api/v1/monitored/cover'

function currentOrigin(): string | null {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  if (typeof location !== 'undefined' && location.origin) return location.origin
  return null
}

/**
 * Rewrites external catalog cover URLs (Hardcover CDN etc.) to the monitored
 * cover endpoint, which resizes and disk-caches them server-side and serves
 * them with immutable cache headers. Local/relative URLs pass through as-is.
 *
 * Mirrors `toDisplayCoverUrl`, but that helper targets the uncached
 * edit-metadata proxy, which is unsuitable for grids rendered on every page view.
 */
export function toMonitoredCoverUrl(url: string | null | undefined): string {
  const raw = url?.trim() ?? ''
  if (!raw) return ''
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw

  const origin = currentOrigin()

  try {
    const parsed = origin ? new URL(raw, origin) : new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw
    if (parsed.pathname === MONITORED_COVER_PATH) return raw

    if (origin) {
      const pageOrigin = new URL(origin).origin
      if (parsed.origin === pageOrigin) return raw
    } else if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      return raw
    }

    return `${MONITORED_COVER_PATH}?url=${encodeURIComponent(parsed.toString())}`
  } catch {
    return raw
  }
}
