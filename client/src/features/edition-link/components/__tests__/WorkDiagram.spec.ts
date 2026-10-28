import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkDiagram from '../WorkDiagram.vue'

function render(props: Record<string, unknown> = {}) {
  return mount(WorkDiagram, { props: { enabled: true, shareReadingState: true, positionSync: 'rough', absDirection: 'twoWay', ...props } })
}

function active(wrapper: ReturnType<typeof render>, key: string): string | undefined {
  return wrapper.get(`[data-testid="diagram-link-${key}"] [data-active]`).attributes('data-active')
}

describe('WorkDiagram', () => {
  it('shows the four boxes and the shared line', () => {
    const wrapper = render()
    const text = wrapper.text()

    for (const label of ['Audiobookshelf', 'Audiobook', 'Read-along', 'Ebook', 'two-way', 'timing', 'same text']) expect(text).toContain(label)
    expect(text).toContain('one status')
    expect(['abs', 'timing', 'text'].map((key) => active(wrapper, key))).toEqual(['true', 'true', 'true'])
  })

  it('greys every arrow but the narration timing when linking is off', () => {
    const wrapper = render({ enabled: false })
    expect(['abs', 'timing', 'text'].map((key) => active(wrapper, key))).toEqual(['false', 'true', 'false'])
  })

  it('greys the alignment arrows when position sync is off but keeps Audiobookshelf', () => {
    const wrapper = render({ positionSync: 'off' })
    expect(['abs', 'timing', 'text'].map((key) => active(wrapper, key))).toEqual(['true', 'false', 'false'])
  })

  it('names the Audiobookshelf direction, or points to its settings when unknown', () => {
    expect(render({ absDirection: 'pull' }).text()).toContain('pulls in')
    const unknown = render({ absDirection: null })
    expect(unknown.text()).toContain('see Audiobookshelf settings')
    expect(active(unknown, 'abs')).toBe('false')
  })
})
