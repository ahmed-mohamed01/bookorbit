import { describe, expect, it } from 'vitest'
import { isNarrationSettledInView, shouldFollowNarration } from './media-overlay-follow'

function paragraphs() {
  const container = document.createElement('div')
  const first = document.createElement('p')
  first.textContent = 'First sentence.'
  const second = document.createElement('p')
  second.textContent = 'Second sentence.'
  container.append(first, second)
  document.body.appendChild(container)
  return { container, first, second }
}

describe('shouldFollowNarration', () => {
  it('never navigates while the reader is detached', () => {
    const { container, first } = paragraphs()
    const visible = document.createRange()
    visible.selectNodeContents(container)
    expect(shouldFollowNarration(first, visible, true)).toBe(false)
    expect(shouldFollowNarration(null, null, true)).toBe(false)
    container.remove()
  })

  it('navigates when the narrated section is not rendered or nothing is known to be visible', () => {
    const { container, first } = paragraphs()
    expect(shouldFollowNarration(null, null, false)).toBe(true)
    expect(shouldFollowNarration(first, null, false)).toBe(true)
    container.remove()
  })

  it('stays put while the narrated element is already visible', () => {
    const { container, first, second } = paragraphs()
    const visible = document.createRange()
    visible.selectNodeContents(first)
    expect(shouldFollowNarration(first, visible, false)).toBe(false)
    expect(shouldFollowNarration(second, visible, false)).toBe(true)
    container.remove()
  })

  it('navigates when the visible range belongs to another document', () => {
    const { container, first } = paragraphs()
    const other = document.implementation.createHTMLDocument('other')
    const p = other.createElement('p')
    p.textContent = 'elsewhere'
    other.body.appendChild(p)
    const visible = other.createRange()
    visible.selectNodeContents(p)
    expect(shouldFollowNarration(first, visible, false)).toBe(true)
    container.remove()
  })
})

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

function withRects(range: Range, viewport: DOMRect, el: Element, elRect: DOMRect) {
  Object.defineProperty(range, 'getBoundingClientRect', { value: () => viewport, configurable: true })
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => elRect, configurable: true })
}

describe('isNarrationSettledInView', () => {
  it('is settled in paginated flow as soon as the element is on the visible page', () => {
    const { container, first, second } = paragraphs()
    const visible = document.createRange()
    visible.selectNodeContents(first)
    expect(isNarrationSettledInView(first, visible, false)).toBe(true)
    expect(isNarrationSettledInView(second, visible, false)).toBe(false)
    container.remove()
  })

  it('requires the element centre to sit in the middle band of the viewport in scrolled flow', () => {
    const { container, first } = paragraphs()
    const visible = document.createRange()
    visible.selectNodeContents(container)

    withRects(visible, rect(0, 1000), first, rect(480, 520))
    expect(isNarrationSettledInView(first, visible, true)).toBe(true)

    withRects(visible, rect(0, 1000), first, rect(210, 250))
    expect(isNarrationSettledInView(first, visible, true)).toBe(true)

    withRects(visible, rect(0, 1000), first, rect(0, 40))
    expect(isNarrationSettledInView(first, visible, true)).toBe(false)

    withRects(visible, rect(0, 1000), first, rect(900, 960))
    expect(isNarrationSettledInView(first, visible, true)).toBe(false)
    container.remove()
  })

  it('falls back to visibility when the range cannot report a bounding box', () => {
    const { container, first } = paragraphs()
    const visible = document.createRange()
    visible.selectNodeContents(container)
    Object.defineProperty(visible, 'getBoundingClientRect', { value: undefined, configurable: true })
    expect(isNarrationSettledInView(first, visible, true)).toBe(true)
    container.remove()
  })

  it('is never settled when the visible range belongs to another document', () => {
    const { container, first } = paragraphs()
    const other = document.implementation.createHTMLDocument('other')
    const p = other.createElement('p')
    other.body.appendChild(p)
    const visible = other.createRange()
    visible.selectNodeContents(p)
    expect(isNarrationSettledInView(first, visible, false)).toBe(false)
    container.remove()
  })
})
