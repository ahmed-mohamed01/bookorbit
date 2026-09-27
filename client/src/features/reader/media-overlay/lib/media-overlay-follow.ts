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

const SETTLED_BAND_START = 0.2
const SETTLED_BAND_END = 0.8

// True when the narrated element has been brought back into comfortable view:
// on the visible page in paginated flow, or with its centre inside the middle
// band of the viewport in scrolled flow. `visibleRange` is the range foliate
// reports as visible, whose bounding box stands in for the viewport since both
// live in the chapter document's coordinate space.
export function isNarrationSettledInView(el: Element, visibleRange: Range, scrolled: boolean): boolean {
  try {
    if (visibleRange.startContainer.ownerDocument !== el.ownerDocument) return false
    if (!visibleRange.intersectsNode(el)) return false
    if (!scrolled) return true
    if (typeof visibleRange.getBoundingClientRect !== 'function') return true
    const viewport = visibleRange.getBoundingClientRect()
    if (viewport.height <= 0) return true
    const rect = el.getBoundingClientRect()
    const center = (rect.top + rect.bottom) / 2
    return center >= viewport.top + viewport.height * SETTLED_BAND_START && center <= viewport.top + viewport.height * SETTLED_BAND_END
  } catch {
    return false
  }
}
