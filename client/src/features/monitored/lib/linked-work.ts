/** The work a `?work=` deep link names, when it is among the works this page loaded. */
export function linkedWork<T extends { id: string }>(id: unknown, works: readonly T[]): T | undefined {
  return typeof id === 'string' ? works.find((work) => work.id === id) : undefined
}
