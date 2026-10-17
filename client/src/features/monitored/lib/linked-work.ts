/** The work a `?work=` deep link names, when it is among the works this page loaded. */
export function linkedWork<T extends { id: string }>(id: unknown, works: readonly T[]): T | undefined {
  return typeof id === 'string' ? works.find((work) => work.id === id) : undefined
}

export async function resolveLinkedWork<T extends { id: string }>(
  id: unknown,
  works: () => readonly T[],
  load: () => Promise<void>,
  consume: () => Promise<void>,
): Promise<T | undefined> {
  if (id === undefined) return undefined
  let work = linkedWork(id, works())
  try {
    if (!work) {
      await load()
      work = linkedWork(id, works())
    }
    return work
  } finally {
    await consume()
  }
}
