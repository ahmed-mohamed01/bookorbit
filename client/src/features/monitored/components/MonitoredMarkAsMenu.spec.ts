import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { Check } from '@lucide/vue'
import type { MonitoredWork } from '@bookorbit/types'
import MonitoredMarkAsMenu from './MonitoredMarkAsMenu.vue'

const work: MonitoredWork = {
  id: 'work-1',
  title: 'The Long Wait',
  subtitle: null,
  seriesName: null,
  seriesIndex: null,
  seriesMemberships: [],
  releaseYear: 2026,
  ebookReleaseDate: null,
  ebookDatePrecision: null,
  audioReleaseDate: null,
  audioDatePrecision: null,
  coverUrl: null,
  description: null,
  verdict: 'verified',
  flags: [],
  sources: [],
  providerWorkIds: {},
  monitorState: 'monitoring',
  matchedBookId: null,
  ownedFormats: [],
  requestIds: {},
}

// The menu teleports its content once reka opens it, so the wrappers pass it through rendered.
const passthrough = { template: '<div><slot /></div>' }

function mountMenu(overrides: Partial<MonitoredWork> = {}) {
  return mount(MonitoredMarkAsMenu, {
    props: { work: { ...work, ...overrides } },
    global: {
      stubs: {
        DropdownMenu: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuLabel: passthrough,
        DropdownMenuSeparator: passthrough,
        DropdownMenuItem: { template: '<button type="button" @click="$emit(\'click\')"><slot /></button>', emits: ['click'] },
      },
    },
  })
}

const KIND_LABELS = [
  ['book', 'Book', 'One title in the series'],
  ['collection', 'Collection', 'Omnibus or box set of other books'],
  ['split_part', 'Part of a book', 'A split release, like Part 1 of 2'],
  ['anthology', 'Anthology', 'Stories by several authors'],
  ['graphic_novel', 'Comic', 'Graphic novel or manga'],
  ['format_variant', 'Alternate edition', 'Another edition of a book you watch'],
  ['duplicate', 'Duplicate', 'Same book listed twice'],
] as const

describe('MonitoredMarkAsMenu', () => {
  it('offers every kind with its one-line description and the review note', () => {
    const wrapper = mountMenu()

    for (const [kind, title, description] of KIND_LABELS) {
      const item = wrapper.get(`[data-testid="mark-as-${kind}"]`)
      expect(item.text()).toContain(title)
      expect(item.text()).toContain(description)
    }
    expect(wrapper.get('[data-testid="mark-as-note"]').text()).toBe('Anything other than Book moves to Review and is no longer searched.')
    expect(wrapper.text()).toContain('Mark as')
    wrapper.unmount()
  })

  it('checks the kind the work already reads as, which defaults to a plain book', () => {
    const plain = mountMenu()
    expect(plain.get('[data-testid="mark-as-book"]').findComponent(Check).exists()).toBe(true)
    expect(plain.get('[data-testid="mark-as-duplicate"]').findComponent(Check).exists()).toBe(false)
    plain.unmount()

    const marked = mountMenu({ userKind: 'duplicate' })
    expect(marked.get('[data-testid="mark-as-duplicate"]').findComponent(Check).exists()).toBe(true)
    expect(marked.get('[data-testid="mark-as-duplicate"]').attributes()).toMatchObject({ role: 'menuitemradio', 'aria-checked': 'true' })
    expect(marked.get('[data-testid="mark-as-book"]').attributes('aria-checked')).toBe('false')
    marked.unmount()

    const reconciled = mountMenu({ kind: 'anthology' })
    expect(reconciled.get('[data-testid="mark-as-anthology"]').findComponent(Check).exists()).toBe(true)
    reconciled.unmount()
  })

  it('ticks nothing for a work in review on its verdict alone, so Book can keep it', async () => {
    const unverified = mountMenu({ verdict: 'suspect' })
    expect(unverified.findAllComponents(Check)).toHaveLength(0)
    await unverified.get('[data-testid="mark-as-book"]').trigger('click')
    expect(unverified.emitted('select')).toEqual([['book']])
    unverified.unmount()

    const hidden = mountMenu({ userVisibility: 'hidden' })
    expect(hidden.get('[data-testid="mark-as-book"]').findComponent(Check).exists()).toBe(true)
    hidden.unmount()
  })

  it('emits only a kind the work does not already read as', async () => {
    const wrapper = mountMenu({ userKind: 'duplicate' })

    await wrapper.get('[data-testid="mark-as-duplicate"]').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()

    await wrapper.get('[data-testid="mark-as-graphic_novel"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['graphic_novel']])
    wrapper.unmount()
  })
})
