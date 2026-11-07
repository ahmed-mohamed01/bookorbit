export function createCachedRequest<T>(load: (isCurrent: () => boolean) => Promise<T>) {
  let request: Promise<T> | null = null

  let generation = 0

  function invalidate(): void {
    generation++
    request = null
  }

  function get(options: { force?: boolean } = {}): Promise<T> {
    if (options.force) invalidate()
    if (!request) {
      const startedGeneration = ++generation
      const next = load(() => generation === startedGeneration)
      request = next
      void next.catch(() => {
        if (request === next) invalidate()
      })
    }
    return request
  }

  return { get, invalidate }
}
