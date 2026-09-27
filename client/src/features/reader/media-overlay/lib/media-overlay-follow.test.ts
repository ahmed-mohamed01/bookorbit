import { describe, expect, it } from 'vitest'
import { decideNarrationFollow, isNarrationInView } from './media-overlay-follow'

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

function rangeOver(node: Node) {
  const range = node.ownerDocument!.createRange()
  range.selectNodeContents(node)
  return range
}

const attached = { detached: false, wasInView: true, scrolling: false }
const drifting = { detached: true, wasInView: true, scrolling: false }
const away = { detached: true, wasInView: false, scrolling: false }

describe('isNarrationInView', () => {
  it('reports whether the element overlaps the visible range of its own document', () => {
    const { container, first, second } = paragraphs()
    expect(isNarrationInView(first, rangeOver(first))).toBe(true)
    expect(isNarrationInView(second, rangeOver(first))).toBe(false)
    expect(isNarrationInView(null, rangeOver(first))).toBe(false)
    expect(isNarrationInView(first, null)).toBe(false)

    const other = document.implementation.createHTMLDocument('other')
    const p = other.createElement('p')
    other.body.appendChild(p)
    expect(isNarrationInView(first, rangeOver(p))).toBe(false)
    container.remove()
  })
})

describe('decideNarrationFollow', () => {
  it('always follows while attached, even before the section is rendered', () => {
    const { container, first, second } = paragraphs()
    expect(decideNarrationFollow(first, rangeOver(first), attached)).toEqual({ follow: true, attach: false, inView: true })
    expect(decideNarrationFollow(second, rangeOver(first), attached)).toEqual({ follow: true, attach: false, inView: true })
    expect(decideNarrationFollow(null, null, attached)).toEqual({ follow: true, attach: false, inView: true })
    container.remove()
  })

  it('lets a visible highlight drift after the reader scrolled', () => {
    const { container, first } = paragraphs()
    expect(decideNarrationFollow(first, rangeOver(container), drifting)).toEqual({ follow: false, attach: false, inView: true })
    expect(decideNarrationFollow(first, rangeOver(container), away)).toEqual({ follow: false, attach: false, inView: true })
    container.remove()
  })

  it('catches up and re-attaches once a drifting highlight leaves the view', () => {
    const { container, first, second } = paragraphs()
    expect(decideNarrationFollow(second, rangeOver(first), drifting)).toEqual({ follow: true, attach: true, inView: true })
    expect(decideNarrationFollow(null, rangeOver(first), drifting)).toEqual({ follow: true, attach: true, inView: true })
    container.remove()
  })

  it('stays put when the reader had already moved away from the highlight', () => {
    const { container, first, second } = paragraphs()
    expect(decideNarrationFollow(second, rangeOver(first), away)).toEqual({ follow: false, attach: false, inView: false })
    container.remove()
  })

  it('never moves the view while a scroll is in progress', () => {
    const { container, first, second } = paragraphs()
    const scrolling = { ...drifting, scrolling: true }
    expect(decideNarrationFollow(second, rangeOver(first), scrolling)).toEqual({ follow: false, attach: false, inView: false })
    container.remove()
  })
})
