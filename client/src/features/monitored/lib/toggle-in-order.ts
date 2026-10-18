/** Toggles one entry of a canonical order: the result always follows `order`, whatever the stored selection held. */
export function toggleInOrder<T extends string>(order: readonly T[], selection: readonly T[], item: T): T[] {
  return order.filter((entry) => (entry === item ? !selection.includes(entry) : selection.includes(entry)))
}
