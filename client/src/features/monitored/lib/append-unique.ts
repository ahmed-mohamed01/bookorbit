/**
 * Appends a freshly fetched page onto the rows already on screen, dropping anything whose identity
 * is already present. Page offsets shift when another session adds or removes a monitored row
 * between fetches, so the same item can arrive twice; a plain concat would render it twice.
 */
export function appendUnique<T>(current: readonly T[], incoming: readonly T[], identity: (item: T) => string): T[] {
  const seen = new Set(current.map(identity))
  const merged = [...current]
  for (const item of incoming) {
    const key = identity(item)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}
