const MONITORED_AUTHORS_PATH = '/api/v1/monitored/authors'

/**
 * Portraits are served under the monitor's own id rather than the linked library author's, so
 * they resolve for monitored authors whose books are not in the viewer's libraries.
 */
export function monitoredPortraitUrl(monitorId: string): string {
  return `${MONITORED_AUTHORS_PATH}/${encodeURIComponent(monitorId)}/portrait`
}
