const NEXT = new Set(['ArrowRight', 'ArrowDown'])
const PREVIOUS = new Set(['ArrowLeft', 'ArrowUp'])

/** Arrow keys move a radiogroup's choice to its neighbour (wrapping) and focus it; returns whether the key was used. */
export function moveRadioChoice(event: KeyboardEvent): boolean {
  const group = event.currentTarget
  if (!(group instanceof HTMLElement)) return false
  const step = NEXT.has(event.key) ? 1 : PREVIOUS.has(event.key) ? -1 : 0
  if (step === 0) return false
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  const current = radios.findIndex((radio) => radio === document.activeElement)
  if (current === -1 || radios.length < 2) return false
  const target = radios[(current + step + radios.length) % radios.length]
  if (!target) return false
  event.preventDefault()
  target.click()
  target.focus()
  return true
}
