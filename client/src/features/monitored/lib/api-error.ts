/**
 * A failed monitored API call. The server's own message is the only text worth showing verbatim;
 * every other case falls back to a translated string chosen by the caller, so nothing user-facing
 * is hardcoded English.
 */
export class MonitoredApiError extends Error {
  readonly status: number
  readonly serverMessage: string | null

  constructor(status: number, serverMessage: string | null) {
    super(serverMessage ?? '')
    this.name = 'MonitoredApiError'
    this.status = status
    this.serverMessage = serverMessage
  }
}

export function monitoredErrorText(cause: unknown, fallback: string): string {
  if (cause instanceof MonitoredApiError && cause.serverMessage) return cause.serverMessage
  return fallback
}
