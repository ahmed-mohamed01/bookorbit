import { describe, expect, it, vi } from 'vitest'
import { useMediaOverlayFollow } from './useMediaOverlayFollow'

function setup(overrides: Partial<{ narrating: boolean; scrolled: boolean }> = {}) {
  const state = { narrating: true, scrolled: true, ...overrides }
  const onScrollIntent = vi.fn<() => void>()
  const follow = useMediaOverlayFollow({
    isNarrating: () => state.narrating,
    isScrolledFlow: () => state.scrolled,
    onScrollIntent,
  })
  return { follow, state, onScrollIntent }
}

function touchMove(doc: Document, touches = 1) {
  const event = new Event('touchmove') as TouchEvent
  Object.defineProperty(event, 'touches', { value: Array.from({ length: touches }, () => ({})) })
  doc.dispatchEvent(event)
}

describe('useMediaOverlayFollow', () => {
  it('reports wheel scrolling inside the chapter while narrating in scrolled flow', () => {
    const { follow, onScrollIntent } = setup()
    follow.bindChapterDocument(document)

    document.dispatchEvent(new Event('wheel'))

    expect(onScrollIntent).toHaveBeenCalledOnce()
    follow.cleanup()
  })

  it('ignores wheel events in paginated flow and when narration is inactive', () => {
    const { follow, state, onScrollIntent } = setup({ scrolled: false })
    follow.bindChapterDocument(document)

    document.dispatchEvent(new Event('wheel'))
    state.scrolled = true
    state.narrating = false
    document.dispatchEvent(new Event('wheel'))

    expect(onScrollIntent).not.toHaveBeenCalled()
    follow.cleanup()
  })

  it('treats a single-finger drag as scrolling unless text is being selected', () => {
    const { follow, onScrollIntent } = setup()
    follow.bindChapterDocument(document)

    touchMove(document, 2)
    expect(onScrollIntent).not.toHaveBeenCalled()

    touchMove(document)
    expect(onScrollIntent).toHaveBeenCalledOnce()

    const selection = window.getSelection()!
    const text = document.createTextNode('selected words')
    document.body.appendChild(text)
    const range = document.createRange()
    range.selectNodeContents(text)
    selection.removeAllRanges()
    selection.addRange(range)

    touchMove(document)
    expect(onScrollIntent).toHaveBeenCalledOnce()

    selection.removeAllRanges()
    text.remove()
    follow.cleanup()
  })

  it('reports relocates the paginator attributes to a native scroll', () => {
    const { follow, onScrollIntent } = setup({ scrolled: false })
    const renderer = new EventTarget()
    follow.bindRenderer(renderer)

    renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'navigation' } }))
    expect(onScrollIntent).not.toHaveBeenCalled()

    renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'scroll' } }))
    expect(onScrollIntent).toHaveBeenCalledOnce()
    follow.cleanup()
  })

  it('rebinding the same renderer does not duplicate listeners and cleanup removes them', () => {
    const { follow, onScrollIntent } = setup()
    const renderer = new EventTarget()
    follow.bindRenderer(renderer)
    follow.bindRenderer(renderer)
    follow.bindChapterDocument(document)
    follow.bindChapterDocument(document)

    renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'scroll' } }))
    document.dispatchEvent(new Event('wheel'))
    expect(onScrollIntent).toHaveBeenCalledTimes(2)

    follow.cleanup()
    renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'scroll' } }))
    document.dispatchEvent(new Event('wheel'))
    expect(onScrollIntent).toHaveBeenCalledTimes(2)
  })
})
