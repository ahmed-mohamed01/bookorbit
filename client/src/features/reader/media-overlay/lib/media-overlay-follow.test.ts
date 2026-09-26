import { describe, expect, it } from 'vitest'
import { shouldFollowNarration } from './media-overlay-follow'

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
