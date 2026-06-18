import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'

interface UseModalOptions {
  /** The modal panel root. The focus trap cycles within it and it receives initial focus as a fallback. */
  container: Ref<HTMLElement | null>
  /** Invoked when Escape is pressed (unless `disabled` returns true). */
  onClose: () => void
  /** Makes this modal inert (no Escape, no focus trap) while true, e.g. when a nested modal is open above it. */
  disabled?: () => boolean
  /** Element to focus on open; falls back to the first focusable element in the container. */
  initialFocus?: Ref<HTMLElement | null>
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Shared modal behaviour for hand-rolled dialogs: body scroll lock, focus save/restore,
 * Escape-to-close, and a Tab focus trap. Wire it once per modal component in setup.
 */
export function useModal(options: UseModalOptions): void {
  let previouslyFocused: HTMLElement | null = null
  let previousOverflow = ''

  function focusable(): HTMLElement[] {
    const root = options.container.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.getClientRects().length > 0)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (options.disabled?.()) return
    if (event.key === 'Escape') {
      event.preventDefault()
      options.onClose()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusable()
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (!first || !last) return
    const active = document.activeElement as HTMLElement | null
    const outside = !options.container.value?.contains(active)
    if (event.shiftKey && (active === first || outside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    previouslyFocused = document.activeElement as HTMLElement | null
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeydown)
    void nextTick(() => {
      const target = options.initialFocus?.value ?? focusable()[0] ?? options.container.value
      target?.focus()
    })
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown)
    document.body.style.overflow = previousOverflow
    previouslyFocused?.focus?.()
  })
}
