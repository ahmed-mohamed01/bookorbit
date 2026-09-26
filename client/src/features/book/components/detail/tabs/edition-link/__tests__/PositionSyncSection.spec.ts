import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import PositionSyncSection from '../PositionSyncSection.vue'
import { withMessages } from './with-messages'

type SectionProps = InstanceType<typeof PositionSyncSection>['$props']

function mountSection(props: Partial<SectionProps> = {}) {
  return mount(PositionSyncSection, {
    props: {
      status: 'none',
      samplesDone: null,
      samplesTotal: null,
      builtAt: null,
      buildBlocked: null,
      mutating: false,
      canBuild: true,
      counterpartModality: null,
      ...props,
    } as SectionProps,
  })
}

function tickClasses(wrapper: ReturnType<typeof mountSection>) {
  return wrapper.findAll('[data-testid="position-sync-tick"]').map((tick) => {
    if (tick.classes('animate-pulse')) return 'current'
    return tick.classes('bg-info') ? 'done' : 'todo'
  })
}

describe('PositionSyncSection', () => {
  it.each([
    ['none', 'Not built', 'bg-muted'],
    ['pending', 'Aligning', 'bg-info/15'],
    ['building', 'Aligning', 'bg-info/15'],
    ['ready', 'Synced', 'bg-success/15'],
    ['failed', 'Failed', 'bg-destructive/15'],
    ['unalignable', "Can't align", 'bg-muted'],
  ] as [AlignmentStatus, string, string][])('tags %s as %s', (status, label, tint) => {
    const wrapper = mountSection({ status })

    const tag = wrapper.get('[data-testid="position-sync-tag"]')
    expect(tag.text()).toBe(label)
    expect(tag.classes()).toContain(tint)
  })

  describe('while running', () => {
    it('buckets more than 40 samples into 40 ticks', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 50, samplesTotal: 100 })

      const ticks = tickClasses(wrapper)
      expect(ticks).toHaveLength(40)
      expect(ticks.filter((tick) => tick === 'done')).toHaveLength(20)
      expect(ticks[20]).toBe('current')
      expect(ticks.slice(21).every((tick) => tick === 'todo')).toBe(true)
    })

    it('uses one tick per sample for small builds', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 0, samplesTotal: 7 })

      expect(tickClasses(wrapper)).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'])
    })

    it('fills every tick once all samples are done, with no pulsing tick left', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 41, samplesTotal: 41 })

      const ticks = tickClasses(wrapper)
      expect(ticks).toHaveLength(40)
      expect(ticks.every((tick) => tick === 'done')).toBe(true)
    })

    it('pulses the whole strip once every sample is done, since no tick is current', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 12, samplesTotal: 12 })

      expect(wrapper.get('[data-testid="position-sync-ticks"]').classes()).toContain('animate-pulse')
    })

    it('pulses only the current tick while samples remain', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 3, samplesTotal: 12 })

      expect(wrapper.get('[data-testid="position-sync-ticks"]').classes()).not.toContain('animate-pulse')
      expect(wrapper.findAll('[data-testid="position-sync-tick"]')[3]?.classes()).toContain('animate-pulse')
    })

    it('pulses the whole strip before the first sample count arrives', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: null, samplesTotal: 12 })

      expect(wrapper.get('[data-testid="position-sync-ticks"]').classes()).toContain('animate-pulse')
    })

    it('animates a tick filling in rather than snapping', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 3, samplesTotal: 12 })

      expect(wrapper.get('[data-testid="position-sync-tick"]').classes()).toEqual(expect.arrayContaining(['transition-colors', 'duration-500']))
    })

    it('never reports progress below zero', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: -5, samplesTotal: 12 })

      expect(wrapper.get('[data-testid="position-sync-ticks"]').attributes('aria-valuenow')).toBe('0')
    })

    it('pulses a single bar while the total is unknown', () => {
      const wrapper = mountSection({ status: 'pending', samplesTotal: null })

      expect(wrapper.find('[data-testid="position-sync-indeterminate"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="position-sync-ticks"]').exists()).toBe(false)
    })

    it('shows no counts and hides the build button', () => {
      const wrapper = mountSection({ status: 'building', samplesDone: 3, samplesTotal: 12 })

      expect(wrapper.text()).not.toMatch(/\d/)
      expect(wrapper.find('[data-testid="position-sync-build"]').exists()).toBe(false)
    })
  })

  describe('build button', () => {
    it('offers Build for a pair that was never built, without force', async () => {
      const wrapper = mountSection({ status: 'none' })

      const button = wrapper.get('[data-testid="position-sync-build"]')
      expect(button.text()).toBe('Build')
      await button.trigger('click')
      expect(wrapper.emitted('build')?.[0]).toEqual([false])
    })

    // A 'failed' rebuild must resume rather than restart, so only 'ready' forces.
    it.each([
      ['ready', true],
      ['failed', false],
      ['unalignable', false],
    ] as [AlignmentStatus, boolean][])('offers Rebuild for %s with force=%s', async (status, force) => {
      const wrapper = mountSection({ status })

      const button = wrapper.get('[data-testid="position-sync-build"]')
      expect(button.text()).toBe('Rebuild')
      await button.trigger('click')
      expect(wrapper.emitted('build')?.[0]).toEqual([force])
    })

    it('is hidden without the permission to build', () => {
      const wrapper = mountSection({ status: 'ready', canBuild: false })

      expect(wrapper.find('[data-testid="position-sync-build"]').exists()).toBe(false)
    })

    it('is disabled while a request is in flight', () => {
      const wrapper = mountSection({ status: 'ready', mutating: true })

      expect(wrapper.get('[data-testid="position-sync-build"]').attributes('disabled')).toBeDefined()
    })
  })

  describe('block reasons', () => {
    it.each([
      ['disabled', 'turned off'],
      ['unavailable', "isn't configured"],
    ] as const)('hides the button for a terminal %s block and says why', (buildBlocked, expected) => {
      const wrapper = mountSection({ buildBlocked })

      expect(wrapper.get('[data-testid="position-sync-blocked"]').text()).toContain(expected)
      expect(wrapper.find('[data-testid="position-sync-build"]').exists()).toBe(false)
    })

    it('keeps the button for a busy block so it can be retried', () => {
      const wrapper = mountSection({ buildBlocked: 'busy' })

      expect(wrapper.get('[data-testid="position-sync-blocked"]').text()).toContain('busy')
      expect(wrapper.find('[data-testid="position-sync-build"]').exists()).toBe(true)
    })
  })

  describe('bodies', () => {
    it('explains an idle pair', () => {
      const wrapper = mountSection({ status: 'none' })

      expect(wrapper.get('[data-testid="position-sync-idle"]').text()).toBe('Maps audio to text so your position carries between editions.')
    })

    it('shows the build date and names the counterpart by its format once ready', () => {
      const wrapper = mountSection({ status: 'ready', builtAt: '2026-02-02T12:00:00.000Z', counterpartModality: 'audiobook' })

      const done = wrapper.get('[data-testid="position-sync-done"]')
      expect(done.text()).toContain('Built')
      expect(done.text()).toContain('2026')
      expect(wrapper.get('[data-testid="position-sync-in-sync"]').text()).toBe('In sync with the audiobook')
    })

    it('adds the title where no pair box shows it', () => {
      const wrapper = mountSection({ status: 'ready', counterpartModality: 'ebook', counterpartTitle: 'Dune' })

      expect(wrapper.get('[data-testid="position-sync-in-sync"]').text()).toBe('In sync with the ebook: Dune')
    })

    // Lower-casing a translated label breaks languages that capitalise nouns, so the in-sentence form
    // has its own key.
    it('names the counterpart with its in-sentence form from the catalog', async () => {
      await withMessages(
        {
          book: {
            detail: {
              editionLink: { counterpartAudiobook: 'Hörbuch' },
              readingAlignment: { counterpartType: { audiobook: 'Hörbuch' } },
            },
          },
        },
        () => {
          const wrapper = mountSection({ status: 'ready', counterpartModality: 'audiobook' })

          expect(wrapper.get('[data-testid="position-sync-in-sync"]').text()).toBe('In sync with the Hörbuch')
        },
      )
    })

    it('says nothing about a counterpart for a book that holds both formats', () => {
      const wrapper = mountSection({ status: 'ready', builtAt: '2026-02-02T12:00:00.000Z' })

      expect(wrapper.find('[data-testid="position-sync-in-sync"]').exists()).toBe(false)
    })

    it('says a failed build can be rebuilt', () => {
      const wrapper = mountSection({ status: 'failed' })

      expect(wrapper.get('[data-testid="position-sync-failed"]').text()).toBe('Position sync failed. Rebuild to try again.')
    })

    it('explains an unalignable pair', () => {
      const wrapper = mountSection({ status: 'unalignable' })

      expect(wrapper.get('[data-testid="position-sync-unalignable"]').text()).toBe("Position sync isn't available for this book pair.")
    })
  })
})
