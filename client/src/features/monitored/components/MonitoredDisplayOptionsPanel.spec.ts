import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredDisplayOptionsPanel from './MonitoredDisplayOptionsPanel.vue'
import { DEFAULT_MONITORED_DISPLAY, type MonitoredDisplayOptions as DisplayOptions, type MonitoredReviewKindCounts } from '../lib/work-visibility'

function kindCounts(overrides: Partial<MonitoredReviewKindCounts> = {}): MonitoredReviewKindCounts {
  return { all: 0, collection: 0, anthology: 0, graphic_novel: 0, format_variant: 0, duplicate: 0, other: 0, ...overrides }
}

function mountPanel(display: Partial<DisplayOptions> = {}, counts: MonitoredReviewKindCounts = kindCounts(), canCurate = true) {
  return mount(MonitoredDisplayOptionsPanel, {
    props: {
      modelValue: { ...DEFAULT_MONITORED_DISPLAY, ...display },
      counts: { hidden: 1, placeholder: 2, review: counts.all },
      reviewKindCounts: counts,
      canCurate,
    },
  })
}

function rowByText(wrapper: ReturnType<typeof mountPanel>, text: string) {
  const row = wrapper.findAll('button').find((button) => button.text().startsWith(text))
  if (!row) throw new Error(`no row starting with "${text}"`)
  return row
}

describe('MonitoredDisplayOptionsPanel', () => {
  it('opens with released and upcoming on and the rest off', () => {
    const wrapper = mountPanel()
    const checked = (label: string) => rowByText(wrapper, label).attributes('aria-checked')

    expect(checked('Show released')).toBe('true')
    expect(checked('Show upcoming')).toBe('true')
    expect(checked('Show hidden')).toBe('false')
    expect(checked('Show placeholders')).toBe('false')
    expect(checked('Show under review')).toBe('false')
    wrapper.unmount()
  })

  it('states every count the moment it opens, with nothing switched on', () => {
    // The counts used to arrive only after a switch forced a refetch, so the menu opened blank.
    const wrapper = mountPanel({}, kindCounts({ all: 45, collection: 10 }))

    expect(rowByText(wrapper, 'Show hidden').text()).toBe('Show hidden1')
    expect(rowByText(wrapper, 'Show placeholders').text()).toBe('Show placeholders2')
    expect(rowByText(wrapper, 'Show under review').text()).toBe('Show under review45')
    wrapper.unmount()
  })

  it('offers a shared viewer only the release switches, never a curation one', () => {
    const wrapper = mountPanel({}, kindCounts({ all: 45 }), false)
    const rows = wrapper.findAll('[role="checkbox"]').map((box) => box.text())

    expect(rows).toEqual(['Show released', 'Show upcoming'])
    wrapper.unmount()
  })

  it('keeps the kind list collapsed until review is switched on', () => {
    const collapsed = mountPanel({}, kindCounts({ all: 3, collection: 3 }))
    expect(collapsed.find('[role="group"]').exists()).toBe(false)
    collapsed.unmount()

    const expanded = mountPanel({ review: true }, kindCounts({ all: 3, collection: 3 }))
    expect(expanded.find('[role="group"]').exists()).toBe(true)
    expanded.unmount()
  })

  it('lists only the kinds this author actually has, always with all', () => {
    const wrapper = mountPanel({ review: true }, kindCounts({ all: 29, collection: 10, anthology: 19 }))
    const kinds = wrapper.findAll('[role="group"] [role="checkbox"]').map((box) => box.text())

    // Declaration order, not count order: a list that reshuffles as the catalog changes is harder
    // to build muscle memory for than one that always reads the same way.
    expect(kinds).toEqual(['All29', 'Collections10', 'Anthologies19'])
    wrapper.unmount()
  })

  it('ticks every kind while the selection is all', () => {
    const wrapper = mountPanel({ review: true }, kindCounts({ all: 29, collection: 10, anthology: 19 }))
    const boxes = wrapper.findAll('[role="group"] [role="checkbox"]')

    expect(boxes.map((box) => box.attributes('aria-checked'))).toEqual(['true', 'true', 'true'])
    wrapper.unmount()
  })

  it('unticks one kind out of all rather than narrowing to just the one clicked', async () => {
    const wrapper = mountPanel({ review: true }, kindCounts({ all: 29, collection: 10, anthology: 19 }))

    await wrapper.findAll('[role="group"] [role="checkbox"]')[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ reviewKinds: ['anthology'] })
    wrapper.unmount()
  })

  it('adds a second kind to a selection instead of replacing it', async () => {
    const wrapper = mountPanel({ review: true, reviewKinds: ['collection'] }, kindCounts({ all: 29, collection: 10, anthology: 19 }))

    await wrapper.findAll('[role="group"] [role="checkbox"]')[2].trigger('click')

    // Collection plus anthology completes the set here, so it folds back to the sentinel.
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ reviewKinds: 'all' })
    wrapper.unmount()
  })

  it('shows all as unticked while only some kinds are picked, and reselects everything on click', async () => {
    const wrapper = mountPanel({ review: true, reviewKinds: ['collection'] }, kindCounts({ all: 29, collection: 10, anthology: 19 }))
    const all = wrapper.findAll('[role="group"] [role="checkbox"]')[0]

    expect(all.attributes('aria-checked')).toBe('false')
    await all.trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ review: true, reviewKinds: 'all' })
    wrapper.unmount()
  })

  it('emits the switch the user flipped and leaves the others alone', async () => {
    const wrapper = mountPanel()

    await rowByText(wrapper, 'Show hidden').trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({ ...DEFAULT_MONITORED_DISPLAY, hidden: true })
    wrapper.unmount()
  })

  it('offers no reset while nothing has been changed', () => {
    const wrapper = mountPanel()

    expect(wrapper.text()).not.toContain('Reset to defaults')
    wrapper.unmount()
  })

  it('offers a reset once a switch is off its default, and asks the owner of the defaults for it', async () => {
    const wrapper = mountPanel({ hidden: true })
    const reset = wrapper.findAll('button').find((button) => button.text().includes('Reset to defaults'))

    await reset?.trigger('click')

    // The panel does not know the defaults; the composable that owns them performs the reset.
    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('switches review off when the last kind is unticked, rather than keeping an empty selection', async () => {
    const wrapper = mountPanel({ review: true, reviewKinds: ['collection'] }, kindCounts({ all: 10, collection: 10, anthology: 5 }))
    const collections = wrapper.findAll('[role="group"] [role="checkbox"]').find((box) => box.text().startsWith('Collections'))

    await collections?.trigger('click')

    // An empty selection is a state storage cannot round-trip, so it never gets created.
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ review: false, reviewKinds: 'all' })
    wrapper.unmount()
  })

  it('drops the selection when review is collapsed, so re-expanding is not silently narrowed', async () => {
    const wrapper = mountPanel({ review: true, reviewKinds: ['collection'] }, kindCounts({ all: 3, collection: 3 }))

    await rowByText(wrapper, 'Show under review').trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ review: false, reviewKinds: 'all' })
    wrapper.unmount()
  })
})
