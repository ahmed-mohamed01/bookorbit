import { getCurrentScope, onScopeDispose } from 'vue'

interface MediaOverlayFollowOptions {
  isNarrating: () => boolean
  isScrolledFlow: () => boolean
  onScrollIntent: () => void
}

interface RendererLike {
  addEventListener?: EventTarget['addEventListener']
  removeEventListener?: EventTarget['removeEventListener']
}

// Notices when the reader scrolls away from narration in scrolled flow. Page
// turns and keyboard navigation are reported by the reader's own navigation
// gate instead, since they go through foliate rather than native scrolling.
export function useMediaOverlayFollow(options: MediaOverlayFollowOptions) {
  let boundRenderer: RendererLike | null = null
  let rendererCleanup: (() => void) | null = null
  const documentCleanups = new Map<Document, () => void>()

  function reportScrollIntent() {
    if (!options.isNarrating() || !options.isScrolledFlow()) return
    options.onScrollIntent()
  }

  // The paginator only tags a relocate with reason "scroll" after a native
  // scroll it did not start itself, so this also catches scrollbar drags.
  function handleRendererRelocate(e: Event) {
    if (!options.isNarrating()) return
    if ((e as CustomEvent).detail?.reason === 'scroll') options.onScrollIntent()
  }

  function handleWheel() {
    reportScrollIntent()
  }

  function handleTouchMove(e: TouchEvent, doc: Document) {
    if (e.touches.length !== 1) return
    const selection = doc.defaultView?.getSelection()
    if (selection && !selection.isCollapsed) return
    reportScrollIntent()
  }

  function bindRenderer(renderer: RendererLike | null) {
    if (renderer === boundRenderer) return
    rendererCleanup?.()
    rendererCleanup = null
    boundRenderer = renderer
    if (!renderer?.addEventListener) return
    renderer.addEventListener('relocate', handleRendererRelocate)
    renderer.addEventListener('wheel', handleWheel, { passive: true })
    rendererCleanup = () => {
      renderer.removeEventListener?.('relocate', handleRendererRelocate)
      renderer.removeEventListener?.('wheel', handleWheel)
    }
  }

  function bindChapterDocument(doc: Document) {
    if (documentCleanups.has(doc)) return
    const onTouchMove = (e: TouchEvent) => handleTouchMove(e, doc)
    doc.addEventListener('wheel', handleWheel, { passive: true })
    doc.addEventListener('touchmove', onTouchMove, { passive: true })
    documentCleanups.set(doc, () => {
      doc.removeEventListener('wheel', handleWheel)
      doc.removeEventListener('touchmove', onTouchMove)
    })
  }

  function cleanup() {
    rendererCleanup?.()
    rendererCleanup = null
    boundRenderer = null
    for (const dispose of documentCleanups.values()) dispose()
    documentCleanups.clear()
  }

  if (getCurrentScope()) onScopeDispose(cleanup)

  return { bindRenderer, bindChapterDocument, cleanup }
}
