// Decides whether the view should navigate to the sentence foliate is about to
// highlight. `el` is the narrated element when its section is loaded, or null
// when the section is not rendered yet.
export function shouldFollowNarration(el: Element | null, visibleRange: Range | null, detached: boolean): boolean {
  if (detached) return false
  if (!el) return true
  if (!visibleRange) return true
  try {
    if (visibleRange.startContainer.ownerDocument !== el.ownerDocument) return true
    return !visibleRange.intersectsNode(el)
  } catch {
    return true
  }
}
