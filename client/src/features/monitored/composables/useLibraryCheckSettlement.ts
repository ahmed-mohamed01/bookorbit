export function useLibraryCheckSettlement(
  isChecking: (id: string) => boolean,
  attempt: (id: string) => Promise<void>,
): (id: string) => Promise<void> {
  const settling = new Set<string>()
  const pending = new Set<string>()
  return async function settle(id: string): Promise<void> {
    if (!isChecking(id)) return
    if (settling.has(id)) {
      pending.add(id)
      return
    }
    settling.add(id)
    try {
      do {
        pending.delete(id)
        await attempt(id)
      } while (isChecking(id) && pending.has(id))
    } finally {
      settling.delete(id)
      pending.delete(id)
    }
  }
}
