import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MonitoredPossibleMatch as PossibleMatch, MonitoredWork } from '@bookorbit/types'
import MonitoredPossibleMatch from './MonitoredPossibleMatch.vue'

const passthrough = { template: '<div><slot /></div>' }

function work(patch: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'Inhibitor Phase',
    seriesName: 'Revelation Space',
    seriesIndex: '4',
    sources: ['hardcover'],
    ...patch,
  } as MonitoredWork
}

const possible: PossibleMatch = { bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' }

function mountMatch(props: Partial<InstanceType<typeof MonitoredPossibleMatch>['$props']> = {}) {
  return mount(MonitoredPossibleMatch, {
    props: { work: work(), format: 'ebook' as const, possible, canAnswer: true, saving: false, ...props },
    global: { stubs: { TooltipProvider: passthrough, Tooltip: passthrough, TooltipTrigger: passthrough, TooltipContent: passthrough } },
  })
}

describe('MonitoredPossibleMatch', () => {
  it('names the library book and says why it is in doubt', () => {
    const wrapper = mountMatch()

    expect(wrapper.get('[data-testid="possible-match-book"]').text()).toBe('Inhibitor Phase (Revelation Space #5)')
    expect(wrapper.text()).toContain('Revelation Space #4')
  })

  it('links the book on Accept and rejects it on Reject', async () => {
    const wrapper = mountMatch()

    await wrapper.get('[data-testid="possible-match-same"]').trigger('click')
    await wrapper.get('[data-testid="possible-match-different"]').trigger('click')

    expect(wrapper.emitted('answer')).toEqual([
      ['ebook', { decision: 'link', bookId: 31 }],
      ['ebook', { decision: 'reject', bookId: 31 }],
    ])
  })

  it('shows the question without answers to a viewer who cannot give one, and locks the answers while one saves', () => {
    expect(mountMatch({ canAnswer: false }).find('[data-testid="possible-match-same"]').exists()).toBe(false)
    expect(mountMatch({ saving: true }).get('[data-testid="possible-match-same"]').attributes('disabled')).toBeDefined()
  })
})
