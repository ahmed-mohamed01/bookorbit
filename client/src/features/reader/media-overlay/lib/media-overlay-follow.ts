export interface NarrationFollowDecision {
  // Navigate to the narrated element, which in scrolled flow pins it to the top of the viewport.
  follow: boolean
  // Leave the detached state because narration has flowed out of the view the reader chose.
  attach: boolean
  // Whether the narrated element is in view after this decision, kept for the next one.
  inView: boolean
}

export function isNarrationInView(el: Element | null, visibleRange: Range | null): boolean {
  if (!el || !visibleRange) return false
  try {
    if (visibleRange.startContainer.ownerDocument !== el.ownerDocument) return false
    return visibleRange.intersectsNode(el)
  } catch {
    return false
  }
}

// Attached narration always follows, so the sentence being read stays at the
// top of the page and the book scrolls past it. After the reader scrolls, the
// highlight is left to drift while it stays visible; once it leaves the view
// (or moves into a section that is not rendered) the view catches up and pins
// again. A highlight that was already out of view stays put, since the reader
// deliberately went elsewhere, and nothing moves while a scroll is in progress.
export function decideNarrationFollow(
  el: Element | null,
  visibleRange: Range | null,
  state: { detached: boolean; wasInView: boolean; scrolling: boolean },
): NarrationFollowDecision {
  if (!state.detached) return { follow: true, attach: false, inView: true }
  const inView = isNarrationInView(el, visibleRange)
  if (inView) return { follow: false, attach: false, inView: true }
  if (state.scrolling) return { follow: false, attach: false, inView: false }
  if (state.wasInView) return { follow: true, attach: true, inView: true }
  return { follow: false, attach: false, inView: false }
}
