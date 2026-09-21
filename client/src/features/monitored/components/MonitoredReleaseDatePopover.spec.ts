import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredReleaseDateCandidate } from '@bookorbit/types'
import MonitoredReleaseDatePopover from './MonitoredReleaseDatePopover.vue'
import type { MonitoredReleaseDateState } from '../composables/useWorkReleaseDates'

// The popover body is teleported and positioned by the UI layer; none of that is under test here.
const passthrough = { template: '<div><slot /></div>' }
// The real tooltip hides its body; this one keeps it readable and exposes the one prop under test.
const tooltipStub = { props: ['disabled'], template: '<div :data-tooltip-disabled="String(disabled)"><slot /></div>' }

function state(overrides: Partial<MonitoredReleaseDateState> = {}): MonitoredReleaseDateState {
  return { candidates: [], unavailable: [], empty: [], loading: false, loaded: true, error: null, saving: false, ...overrides }
}

function candidate(overrides: Partial<MonitoredReleaseDateCandidate> = {}): MonitoredReleaseDateCandidate {
  return { source: 'apple', releaseDate: '2026-07-15', precision: 'day', label: null, weak: false, url: null, ...overrides }
}

function mountPopover(props: Partial<InstanceType<typeof MonitoredReleaseDatePopover>['$props']> = {}) {
  return mount(MonitoredReleaseDatePopover, {
    props: {
      format: 'ebook' as const,
      open: true,
      label: 'TBA',
      muted: true,
      currentDate: null,
      source: null,
      details: [],
      suggestion: null,
      state: state(),
      ...props,
    },
    global: {
      stubs: {
        Popover: passthrough,
        PopoverTrigger: passthrough,
        PopoverContent: passthrough,
        TooltipProvider: passthrough,
        Tooltip: tooltipStub,
        TooltipTrigger: passthrough,
        TooltipContent: passthrough,
      },
    },
  })
}

describe('MonitoredReleaseDatePopover', () => {
  it('titles itself for the format and shows what the row already says', () => {
    const wrapper = mountPopover()

    expect(wrapper.text()).toContain('Ebook release date')
    expect(wrapper.get('button[aria-label^="Ebook release date"]').text()).toContain('TBA')
    wrapper.unmount()
  })

  it('explains on hover where the date came from and what a click does', () => {
    const wrapper = mountPopover({ source: 'hardcover_edition', details: ['Release date as per Hardcover.', 'Checked 2 hours ago'] })

    const hint = wrapper.get('[data-testid="release-date-hint"]').text()
    expect(hint).toContain('Release date as per Hardcover.')
    expect(hint).toContain('Checked 2 hours ago')
    expect(hint).toContain('Click to search other providers.')
    wrapper.unmount()
  })

  it('repeats where the date came from inside the panel, where touch screens can read it', () => {
    const wrapper = mountPopover({ source: 'hardcover_edition', details: ['Release date as per Hardcover.', 'Checked 2 hours ago'] })

    const details = wrapper.get('[data-testid="release-date-details"]')
    expect(details.findAll('span').map((line) => line.text())).toEqual(['Release date as per Hardcover.', 'Checked 2 hours ago'])
    wrapper.unmount()
  })

  it('invites a first search when no provider has dated the format', () => {
    const wrapper = mountPopover()

    expect(wrapper.get('[data-testid="release-date-hint"]').text()).toBe('Click to search providers for a date.')
    expect(wrapper.find('[data-testid="release-date-details"]').exists()).toBe(false)
    wrapper.unmount()
  })

  const suggestion = { releaseDate: '2026-10-20', applicableDate: '2026-10-20', text: 'Amazon now lists 20 October 2026, found 2 days ago.' }

  it('puts a listing that disagrees with the owner in front of the candidates, with both answers', () => {
    const wrapper = mountPopover({ source: 'user', currentDate: '2026-10-06', suggestion })

    const banner = wrapper.get('[data-testid="release-date-suggestion-banner"]')
    expect(banner.text()).toContain('Amazon now lists 20 October 2026, found 2 days ago.')
    expect(banner.text()).toContain('Use this date')
    expect(banner.text()).toContain('Keep my date')
    wrapper.unmount()
  })

  it('sets the listed date when the owner uses it', async () => {
    const wrapper = mountPopover({ source: 'user', currentDate: '2026-10-06', suggestion })

    await wrapper.get('[data-testid="release-date-suggestion-banner"]').findAll('button')[0]!.trigger('click')

    expect(wrapper.emitted('set')).toEqual([['ebook', '2026-10-20']])
    wrapper.unmount()
  })

  it('sets the date the owner already has when they keep it, which is what settles the alert', async () => {
    const wrapper = mountPopover({ source: 'user', currentDate: '2026-10-06', suggestion })

    await wrapper.get('[data-testid="release-date-suggestion-banner"]').findAll('button')[1]!.trigger('click')

    expect(wrapper.emitted('set')).toEqual([['ebook', '2026-10-06']])
    wrapper.unmount()
  })

  it('offers only to keep the date when the listing is not a full date', () => {
    const wrapper = mountPopover({
      source: 'user',
      currentDate: '2026-10-06',
      suggestion: { ...suggestion, releaseDate: '2026-11', applicableDate: null },
    })

    const buttons = wrapper.get('[data-testid="release-date-suggestion-banner"]').findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['Keep my date'])
    wrapper.unmount()
  })

  it('shows no banner without a disagreement', () => {
    const wrapper = mountPopover()

    expect(wrapper.find('[data-testid="release-date-suggestion-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('switches the hover tooltip off while the popover is open, so it never sits on top of it', () => {
    const open = mountPopover({ open: true })
    const closed = mountPopover({ open: false })

    expect(open.get('[data-tooltip-disabled]').attributes('data-tooltip-disabled')).toBe('true')
    expect(closed.get('[data-tooltip-disabled]').attributes('data-tooltip-disabled')).toBe('false')
    open.unmount()
    closed.unmount()
  })

  it('shows a loading state while the providers are being asked', () => {
    const wrapper = mountPopover({ state: state({ loading: true, loaded: false }) })

    expect(wrapper.text()).toContain('Looking up release dates...')
    expect(wrapper.find('ul').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lists each candidate with its source, listing label and link', () => {
    const wrapper = mountPopover({
      state: state({
        candidates: [candidate({ label: 'Kindle, Orbit', url: 'https://example.test/listing' }), candidate({ source: 'audible', weak: true })],
      }),
    })

    const rows = wrapper.findAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('2026')
    expect(rows[0].text()).toContain('Apple Books · Kindle, Orbit')
    expect(rows[1].text()).toContain('Placeholder')

    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe('https://example.test/listing')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(link.attributes('aria-label')).toBe('Open the Apple Books listing in a new tab')
    wrapper.unmount()
  })

  it('applies a day-precision candidate straight away', async () => {
    const wrapper = mountPopover({ state: state({ candidates: [candidate()] }) })

    await wrapper.get('li button').trigger('click')

    expect(wrapper.emitted('set')).toEqual([['ebook', '2026-07-15']])
    wrapper.unmount()
  })

  it('pre-fills the manual field from a candidate the provider only dates to a month', async () => {
    const wrapper = mountPopover({ state: state({ candidates: [candidate({ releaseDate: '2026-07', precision: 'month' })] }) })

    await wrapper.get('li button').trigger('click')

    expect(wrapper.emitted('set')).toBeUndefined()
    expect((wrapper.get('input[type="date"]').element as HTMLInputElement).value).toBe('2026-07-01')
    expect(wrapper.text()).toContain('Pick the exact day below.')
    wrapper.unmount()
  })

  it('sets a date the owner types in by hand', async () => {
    const wrapper = mountPopover()
    const setButton = wrapper.findAll('button').find((button) => button.text() === 'Set')

    expect(setButton?.attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="date"]').setValue('2026-11-03')
    await setButton?.trigger('click')

    expect(wrapper.emitted('set')).toEqual([['ebook', '2026-11-03']])
    wrapper.unmount()
  })

  it('opens the manual field on the date the row already carries', async () => {
    const wrapper = mountPopover({ open: false, currentDate: '2026-07-15', label: '15 July 2026', muted: false })

    await wrapper.setProps({ open: true })
    await nextTick()

    expect((wrapper.get('input[type="date"]').element as HTMLInputElement).value).toBe('2026-07-15')
    wrapper.unmount()
  })

  it('offers to clear only a date the owner set, and says what that does', async () => {
    const automatic = mountPopover({ source: 'apple' })
    expect(automatic.findAll('button').some((button) => button.text() === 'Clear my date')).toBe(false)
    automatic.unmount()

    const wrapper = mountPopover({ source: 'user', currentDate: '2026-11-03', label: '3 November 2026', muted: false })
    const clearButton = wrapper.findAll('button').find((button) => button.text() === 'Clear my date')

    expect(wrapper.text()).toContain('This hands the format back to the automatic check.')
    await clearButton?.trigger('click')

    expect(wrapper.emitted('clear')).toEqual([['ebook']])
    wrapper.unmount()
  })

  it('names the providers it could not ask so an empty list is not read as an answer', () => {
    const wrapper = mountPopover({
      format: 'audiobook',
      state: state({
        unavailable: [
          { source: 'audible', reason: 'not_configured' },
          { source: 'apple', reason: 'throttled' },
          { source: 'amazon', reason: 'failed' },
        ],
      }),
    })

    expect(wrapper.text()).toContain('No store lists a date for this format yet.')
    expect(wrapper.text()).toContain('Audible is not set up')
    expect(wrapper.text()).toContain('Apple Books is busy, try later')
    expect(wrapper.text()).toContain('Amazon did not answer')
    wrapper.unmount()
  })

  it('still names a missing provider when the others did answer', () => {
    const wrapper = mountPopover({
      state: state({ candidates: [candidate()], unavailable: [{ source: 'audible', reason: 'failed' }] }),
    })

    expect(wrapper.text()).not.toContain('No store lists a date for this format yet.')
    expect(wrapper.text()).toContain('Audible did not answer')
    wrapper.unmount()
  })

  it('names the providers that were checked and had no date, new audiobook sources included', () => {
    const wrapper = mountPopover({ format: 'audiobook' as const, state: state({ empty: ['audible', 'audnexus', 'librofm'] }) })

    expect(wrapper.get('[data-testid="release-date-nothing-found"]').text()).toBe('No date from: Audible, Audnexus, Libro.fm')
    wrapper.unmount()
  })

  it('says nothing about checked providers when every one of them had a date', () => {
    const wrapper = mountPopover({ state: state({ candidates: [candidate()] }) })

    expect(wrapper.find('[data-testid="release-date-nothing-found"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('reports a failed lookup in place of the list', () => {
    const wrapper = mountPopover({ state: state({ error: 'Could not look up release dates.' }) })

    expect(wrapper.get('[role="alert"]').text()).toBe('Could not look up release dates.')
    expect(wrapper.find('ul').exists()).toBe(false)
    wrapper.unmount()
  })

  it('holds every action still while a save is in flight', () => {
    const wrapper = mountPopover({ source: 'user', state: state({ candidates: [candidate()], saving: true }) })

    expect(wrapper.get('li button').attributes('disabled')).toBeDefined()
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === 'Clear my date')
        ?.attributes('disabled'),
    ).toBeDefined()
    wrapper.unmount()
  })
})
