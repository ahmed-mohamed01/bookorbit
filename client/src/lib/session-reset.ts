const resets = new Set<() => void>()

export function onSessionCleared(fn: () => void): void {
  resets.add(fn)
}

export function clearSessionState(): void {
  for (const reset of resets) reset()
}
