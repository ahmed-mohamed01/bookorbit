import { describe, expect, it } from 'vitest'
import { storyGuideTabSteps } from './story-guide-tab-steps'

const states = (steps: ReturnType<typeof storyGuideTabSteps>) => steps.map(({ state }) => state)

describe('storyGuideTabSteps', () => {
  it.each([
    [{ kind: 'reading' } as const, ['now', 'pending', 'pending', 'pending', 'pending']],
    [{ kind: 'findingNames' } as const, ['done', 'now', 'pending', 'pending', 'pending']],
    [{ kind: 'checkingWho' } as const, ['done', 'done', 'now', 'pending', 'pending']],
    [{ kind: 'writing', chapter: 17, total: 24 } as const, ['done', 'done', 'done', 'now', 'pending']],
    [{ kind: 'finishing' } as const, ['done', 'done', 'done', 'done', 'now']],
  ])('splits done, now and pending for %o', (phase, expected) => {
    expect(states(storyGuideTabSteps(phase, 0.5))).toEqual(expected)
  })

  it('marks Reading now while a build has reported nothing yet', () => {
    expect(states(storyGuideTabSteps({ kind: 'building' }, 0))).toEqual(['now', 'pending', 'pending', 'pending', 'pending'])
    expect(states(storyGuideTabSteps({ kind: 'building' }, null))).toEqual(['now', 'pending', 'pending', 'pending', 'pending'])
  })

  it('marks everything done and Finishing now once the unit has finished', () => {
    expect(states(storyGuideTabSteps({ kind: 'building' }, 1))).toEqual(['done', 'done', 'done', 'done', 'now'])
  })

  it('places phases outside the list on Writing', () => {
    expect(states(storyGuideTabSteps({ kind: 'findingTies' }, 0))).toEqual(['done', 'done', 'done', 'now', 'pending'])
    expect(states(storyGuideTabSteps({ kind: 'summarizing', chapter: 1, total: 2 }, 0))).toEqual(['done', 'done', 'done', 'now', 'pending'])
  })

  it('keeps the chapter numbers on the now step only', () => {
    const now = storyGuideTabSteps({ kind: 'writing', chapter: 17, total: 24 }, 0.67)
    expect(now[3].phase).toEqual({ kind: 'writing', chapter: 17, total: 24 })
    const pending = storyGuideTabSteps({ kind: 'reading' }, 0)
    expect(pending[3].phase).toEqual({ kind: 'writing', chapter: null, total: null })
  })
})
