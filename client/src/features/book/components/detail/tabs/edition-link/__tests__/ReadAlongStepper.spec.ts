import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ReadAlongStepper from '../ReadAlongStepper.vue'
import { withMessages } from './with-messages'

const states = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('[data-testid="read-along-stage"]').map((stage) => stage.attributes('data-stage-state'))

describe('ReadAlongStepper', () => {
  it.each([
    [0, ['current', 'todo', 'todo', 'todo']],
    [1, ['done', 'current', 'todo', 'todo']],
    [2, ['done', 'done', 'current', 'todo']],
    [3, ['done', 'done', 'done', 'current']],
  ])('marks the stages around stage %i', (stage, expected) => {
    const wrapper = mount(ReadAlongStepper, { props: { stage } })

    expect(states(wrapper)).toEqual(expected)
    expect(wrapper.findAll('[data-testid="read-along-stage"]').map((item) => item.text())).toEqual([
      'Sending',
      'Transcribing',
      'Aligning',
      'Importing',
    ])
    expect(wrapper.findAll('[data-testid="read-along-step-segment"]')[stage]?.classes()).toContain('bg-info')
  })

  it('shows the current step as failed, without the pulse, once the build failed', () => {
    const wrapper = mount(ReadAlongStepper, { props: { stage: 1, failed: true } })
    const segments = wrapper.findAll('[data-testid="read-along-step-segment"]')

    expect(segments[1]?.classes()).toContain('bg-destructive')
    expect(segments[1]?.classes()).not.toContain('animate-pulse')
    expect(segments[1]?.classes()).not.toContain('bg-info')
    expect(segments[0]?.classes()).toContain('bg-success')
    expect(wrapper.findAll('[data-testid="read-along-stage"]')[1]?.classes()).toContain('text-destructive')
    expect(states(wrapper)).toEqual(['done', 'current', 'todo', 'todo'])
  })

  it("shows Storyteller's own progress only while it transcribes or aligns", () => {
    expect(
      mount(ReadAlongStepper, { props: { stage: 1, remoteProgress: 0.42 } })
        .get('[data-testid="read-along-percent"]')
        .text(),
    ).toBe('42%')
    expect(
      mount(ReadAlongStepper, { props: { stage: 0, remoteProgress: 0.42 } })
        .find('[data-testid="read-along-percent"]')
        .exists(),
    ).toBe(false)
    expect(
      mount(ReadAlongStepper, { props: { stage: 3, remoteProgress: 0.42 } })
        .find('[data-testid="read-along-percent"]')
        .exists(),
    ).toBe(false)
    expect(
      mount(ReadAlongStepper, { props: { stage: 2 } })
        .find('[data-testid="read-along-percent"]')
        .exists(),
    ).toBe(false)
  })

  it('reads the stage names and the percentage from the catalog', async () => {
    await withMessages({ book: { detail: { editionLink: { readAlong: { percent: '{percent} %', stages: { aligning: 'Syncing' } } } } } }, () => {
      const wrapper = mount(ReadAlongStepper, { props: { stage: 2, remoteProgress: 0.5 } })

      expect(wrapper.get('[data-testid="read-along-percent"]').text()).toBe('50 %')
      expect(wrapper.text()).toContain('Syncing')
    })
  })
})
