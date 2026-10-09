import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive, AudiobookshelfReconcileDirection } from '@bookorbit/types'
import AudiobookshelfSyncStop from '../AudiobookshelfSyncStop.vue'
import { AudiobookshelfReconcileError } from '@/features/audiobookshelf/api/audiobookshelf.api'
import { i18n } from '@/i18n'
import { withMessages } from './with-messages'

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn<(id: string, direction: AudiobookshelfReconcileDirection) => Promise<AudiobookshelfBookSyncLive>>(),
}))

vi.mock('@/features/audiobookshelf/api/audiobookshelf.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/audiobookshelf/api/audiobookshelf.api')>()),
  reconcileAudiobookshelfPosition: mocks.reconcile,
}))

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } }

function makeLink(overrides: Partial<AudiobookshelfBookSyncLink> = {}): AudiobookshelfBookSyncLink {
  return {
    audioBookId: 20,
    absLibraryItemId: 'abs-1',
    title: 'Dune',
    authorName: 'Frank Herbert',
    libraryName: 'Fiction',
    direction: 'two_way',
    syncing: true,
    pausedReason: null,
    webUrl: 'https://abs.example.com/item/abs-1',
    ...overrides,
  }
}

function makeLive(overrides: Partial<AudiobookshelfBookSyncLive> = {}): AudiobookshelfBookSyncLive {
  return {
    status: 'synced',
    progress: { percentage: 42.4, isFinished: false, lastUpdate: 5000 },
    local: null,
    divergedReason: null,
    ...overrides,
  }
}

function mountStop(
  link = makeLink(),
  live: AudiobookshelfBookSyncLive | null = makeLive(),
  checking = false,
  position: 'middle' | 'bottom' = 'middle',
) {
  return mount(AudiobookshelfSyncStop, {
    props: { link, live, checking, merged: true, connectorPlacement: 'left-5 size-5', position },
    global: { stubs },
  })
}

describe('AudiobookshelfSyncStop', () => {
  beforeEach(() => {
    mocks.reconcile.mockReset()
  })

  it('names the matched item and its library', () => {
    const wrapper = mountStop()

    expect(wrapper.text()).toContain('Audiobookshelf')
    expect(wrapper.text()).toContain('Dune')
    expect(wrapper.text()).toContain('Fiction library')
  })

  it('draws a green link and offers no fix when sync runs both ways', async () => {
    await withMessages({ book: { detail: { editionLink: { abs: { twoWay: 'Both ways' } } } } }, () => {
      const wrapper = mountStop()
      const connector = wrapper.get('[data-testid="edition-connector-abs"]')

      expect(wrapper.get('[data-testid="edition-abs-stop"]').attributes('data-direction')).toBe('two_way')
      expect(connector.classes()).toContain('bg-success')
      expect(connector.attributes('aria-label')).toBe('Both ways')
      expect(wrapper.find('[data-testid="edition-abs-settings"]').exists()).toBe(false)
    })
  })

  it.each([
    ['from_abs', 'fromAbs'],
    ['to_abs', 'toAbs'],
  ] as const)('draws a yellow link with its reason and a way to settings for %s', async (direction, key) => {
    await withMessages({ book: { detail: { editionLink: { abs: { [key]: `Reason ${key}` } } } } }, () => {
      const wrapper = mountStop(makeLink({ direction }))
      const connector = wrapper.get('[data-testid="edition-connector-abs"]')

      expect(connector.classes()).toContain('bg-warning')
      expect(connector.attributes('aria-label')).toBe(`Reason ${key}`)
      expect(wrapper.get('[data-testid="edition-abs-settings"]').attributes('href')).toBe(JSON.stringify({ name: 'settings-audiobookshelf' }))
    })
  })

  it('shows the Audiobookshelf cover and falls back to the library icon when it fails', async () => {
    const wrapper = mountStop(makeLink({ absLibraryItemId: 'abs/1' }))
    const img = wrapper.get('[data-testid="edition-abs-cover"] img')

    expect(img.attributes('src')).toBe('/api/v1/audiobookshelf/books/abs%2F1/cover')

    await img.trigger('error')
    expect(wrapper.find('[data-testid="edition-abs-cover"] img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edition-abs-cover-fallback"]').exists()).toBe(true)

    await wrapper.setProps({ link: makeLink({ absLibraryItemId: 'abs-2' }) })
    expect(wrapper.get('[data-testid="edition-abs-cover"] img').attributes('src')).toBe('/api/v1/audiobookshelf/books/abs-2/cover')
  })

  it('opens the item in Audiobookshelf from an external badge and the title', () => {
    const wrapper = mountStop()
    const badge = wrapper.get('[data-testid="edition-abs-external"]')

    expect(badge.attributes('href')).toBe('https://abs.example.com/item/abs-1')
    expect(badge.attributes('target')).toBe('_blank')
    expect(badge.attributes('rel')).toContain('noopener')
    expect(badge.attributes('aria-label')).toBeUndefined()
    expect(badge.text()).toContain('External')
    expect(badge.text()).toContain('(opens Audiobookshelf in a new tab)')
    expect(wrapper.get('[data-testid="edition-abs-title"]').text()).toContain('(opens Audiobookshelf in a new tab)')
    expect(wrapper.get('[data-testid="edition-abs-title"]').attributes('href')).toBe('https://abs.example.com/item/abs-1')
  })

  it('shows Audiobookshelf progress like the other rows', () => {
    const wrapper = mountStop()

    expect(wrapper.get('[data-testid="edition-abs-progress"]').text()).toContain('42%')
    expect(
      mountStop(makeLink(), makeLive({ progress: null }))
        .find('[data-testid="edition-abs-not-started"]')
        .exists(),
    ).toBe(true)
    expect(
      mountStop(makeLink(), makeLive({ progress: { percentage: 100, isFinished: true, lastUpdate: 1 } }))
        .find('[data-testid="edition-abs-finished"]')
        .exists(),
    ).toBe(true)
  })

  it('never shows 100% before Audiobookshelf calls the book finished', () => {
    const almost = mountStop(makeLink(), makeLive({ progress: { percentage: 99.6, isFinished: false, lastUpdate: 1 } }))

    expect(almost.get('[data-testid="edition-abs-progress"]').text()).toContain('99%')
  })

  it('lets the label row wrap inside the narrow popover', () => {
    const row = mountStop().get('[data-testid="edition-abs-logo"]').element.parentElement

    expect(row?.classList).toContain('flex-wrap')
  })

  it('names the Newer in Audiobookshelf status plainly', () => {
    expect(
      mountStop(makeLink(), makeLive({ status: 'receiving' }))
        .get('[data-testid="edition-abs-status"]')
        .text(),
    ).toBe('Newer in Audiobookshelf')
  })

  it('describes the direction and the status to screen readers without a hover', async () => {
    await withMessages(
      { book: { detail: { editionLink: { abs: { toAbs: 'Reason toAbs', status: { unreachableHint: 'Cannot reach it' } } } } } },
      () => {
        const wrapper = mountStop(makeLink({ direction: 'to_abs' }), makeLive({ status: 'unreachable', progress: null }))
        const stop = wrapper.get('[data-testid="edition-abs-stop"]')
        const hint = wrapper.get('[data-testid="edition-abs-hint"]')

        expect(hint.classes()).toContain('sr-only')
        expect(stop.attributes('aria-describedby')).toBe(hint.attributes('id'))
        expect(hint.text()).toContain('Reason toAbs')
        expect(hint.text()).toContain('Cannot reach it')
      },
    )
  })

  it('opens the reasons inline from the connector or the status, for touch', async () => {
    await withMessages({ book: { detail: { editionLink: { abs: { toAbs: 'Reason toAbs', status: { sendingHint: 'On its way' } } } } } }, async () => {
      const wrapper = mountStop(makeLink({ direction: 'to_abs' }), makeLive({ status: 'sending' }))
      const connector = wrapper.get('[data-testid="edition-connector-abs"]')
      const status = wrapper.get('[data-testid="edition-abs-status"]')
      const details = wrapper.get('[data-testid="edition-abs-details"]')

      expect(details.attributes('style')).toContain('display: none')
      expect(connector.attributes('aria-expanded')).toBe('false')
      expect(connector.attributes('aria-controls')).toBe(details.attributes('id'))
      expect(status.attributes('aria-controls')).toBe(details.attributes('id'))

      await connector.trigger('click')
      expect(details.attributes('style') ?? '').not.toContain('display: none')
      expect(connector.attributes('aria-expanded')).toBe('true')
      expect(details.text()).toContain('Reason toAbs')
      expect(details.text()).toContain('On its way')

      await status.trigger('click')
      expect(details.attributes('style')).toContain('display: none')
    })
  })

  it('leaves the direction out of the open details when sync runs both ways', async () => {
    await withMessages({ book: { detail: { editionLink: { abs: { twoWay: 'Both ways', status: { sendingHint: 'On its way' } } } } } }, async () => {
      const wrapper = mountStop(makeLink(), makeLive({ status: 'sending' }))

      await wrapper.get('[data-testid="edition-connector-abs"]').trigger('click')
      const details = wrapper.get('[data-testid="edition-abs-details"]')
      expect(details.text()).not.toContain('Both ways')
      expect(details.text()).toContain('On its way')
      expect(wrapper.get('[data-testid="edition-abs-hint"]').text()).toContain('Both ways')
    })
  })

  it('stretches a middle rail with the card and ends the last rail at the cover', () => {
    const middle = mountStop(makeLink(), makeLive(), false, 'middle').get('[data-testid="edition-abs-rail"]')
    expect(middle.classes()).toContain('bottom-8')
    expect(middle.classes()).not.toContain('h-16')

    const bottom = mountStop(makeLink(), makeLive(), false, 'bottom').get('[data-testid="edition-abs-rail"]')
    expect(bottom.classes()).toContain('h-16')
    expect(bottom.classes()).not.toContain('bottom-8')
  })

  it.each(['sending', 'receiving'] as const)('replaces the progress with the %s status', (status) => {
    const wrapper = mountStop(makeLink(), makeLive({ status }))

    expect(wrapper.get('[data-testid="edition-abs-status"]').attributes('data-status')).toBe(status)
    expect(wrapper.find('[data-testid="edition-abs-progress"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edition-abs-settings"]').exists()).toBe(false)
  })

  it('says when Audiobookshelf is unreachable and offers settings', () => {
    const wrapper = mountStop(makeLink(), makeLive({ status: 'unreachable', progress: null }))

    expect(wrapper.get('[data-testid="edition-abs-status"]').attributes('data-status')).toBe('unreachable')
    expect(wrapper.find('[data-testid="edition-abs-settings"]').exists()).toBe(true)
  })

  it('shows a checking shimmer until the live status arrives, and nothing if it never does', () => {
    const checking = mountStop(makeLink(), null, true)
    expect(checking.find('[data-testid="edition-abs-checking"]').exists()).toBe(true)
    expect(checking.find('[data-testid="edition-abs-progress"]').exists()).toBe(false)

    const unknown = mountStop(makeLink(), null, false)
    expect(unknown.find('[data-testid="edition-abs-checking"]').exists()).toBe(false)
    expect(unknown.find('[data-testid="edition-abs-not-started"]').exists()).toBe(false)
    expect(unknown.find('[data-testid="edition-abs-progress"]').exists()).toBe(false)
  })

  it('draws the bundled Audiobookshelf logo in the row text colour', () => {
    const logo = mountStop().get('[data-testid="edition-abs-logo"]')

    expect(logo.classes()).toContain('mask-[url(/assets/provider-icons/audiobookshelf.svg)]')
    expect(logo.classes()).toContain('bg-current')
  })

  it('leaves out the library line when Audiobookshelf reported none', () => {
    expect(mountStop(makeLink({ libraryName: null })).text()).not.toContain('library')
  })
  describe('out of sync', () => {
    function divergedLive(reason: AudiobookshelfBookSyncLive['divergedReason'] = 'stale') {
      return makeLive({
        status: 'diverged',
        progress: { percentage: 62.2, isFinished: false, lastUpdate: 5000 },
        local: { percentage: 18.6, capturedAt: '2026-10-01T10:00:00.000Z' },
        divergedReason: reason,
      })
    }

    it('flags the stop with a warning and names both positions and the reason', async () => {
      const wrapper = mountStop(makeLink(), divergedLive('push_off'))
      const status = wrapper.get('[data-testid="edition-abs-status"]')

      expect(status.attributes('data-status')).toBe('diverged')
      expect(status.text()).toBe('Out of sync')
      expect(status.classes()).toContain('text-warning')
      expect(wrapper.find('[data-testid="edition-abs-progress"]').exists()).toBe(false)

      await status.trigger('click')
      expect(wrapper.get('[data-testid="edition-abs-status-hint"]').text()).toBe('Audiobookshelf 62%, BookOrbit 19%. Sending is off.')
    })

    it.each([
      ['pull_refused', 'The last pull did not apply.'],
      ['stale', 'Neither side has moved since the last sync.'],
    ] as const)('explains the %s reason in one clause', async (reason, clause) => {
      const wrapper = mountStop(makeLink(), divergedLive(reason))

      expect(wrapper.get('[data-testid="edition-abs-status-hint"]').text()).toContain(clause)
    })

    it.each([
      ['edition-abs-reconcile-push', 'push', 'Send BookOrbit position'],
      ['edition-abs-reconcile-pull', 'pull', 'Use Audiobookshelf position'],
    ] as const)('reconciles from %s, holds both buttons while it runs, then hands up the fresh status', async (testId, direction, label) => {
      let resolve!: (value: AudiobookshelfBookSyncLive) => void
      mocks.reconcile.mockReturnValue(new Promise((done) => (resolve = done)))
      const wrapper = mountStop(makeLink({ absLibraryItemId: 'abs-9' }), divergedLive())
      const button = wrapper.get(`[data-testid="${testId}"]`)

      expect(button.text()).toBe(label)
      await button.trigger('click')

      expect(mocks.reconcile).toHaveBeenCalledWith('abs-9', direction)
      expect(wrapper.get('[data-testid="edition-abs-reconcile-push"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="edition-abs-reconcile-pull"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get(`[data-testid="${testId}"]`).find('.animate-spin').exists()).toBe(true)

      const fresh = makeLive()
      resolve(fresh)
      await flushPromises()
      expect(wrapper.emitted('refresh-live')).toEqual([[fresh]])
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeUndefined()
    })

    it.each([
      [409, 'Sync is busy, try again in a moment.'],
      [502, 'Could not reach Audiobookshelf.'],
      [404, 'Could not update the position. Try again.'],
    ])('names a %s failure in one line', async (status, line) => {
      mocks.reconcile.mockRejectedValueOnce(new AudiobookshelfReconcileError('nope', status))
      const wrapper = mountStop(makeLink(), divergedLive())

      await wrapper.get('[data-testid="edition-abs-reconcile-push"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="edition-abs-reconcile-error"]').text()).toBe(line)
    })

    it('says so in one line when a reconcile fails and lets the user try again', async () => {
      mocks.reconcile.mockRejectedValueOnce(new Error('An Audiobookshelf sync is already running'))
      const wrapper = mountStop(makeLink(), divergedLive())

      await wrapper.get('[data-testid="edition-abs-reconcile-pull"]').trigger('click')
      await flushPromises()

      const details = wrapper.get('[data-testid="edition-abs-details"]')
      expect(details.attributes('style') ?? '').not.toContain('display: none')
      expect(wrapper.get('[data-testid="edition-abs-reconcile-error"]').text()).toBe('Could not update the position. Try again.')
      expect(wrapper.get('[data-testid="edition-abs-reconcile-pull"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.emitted('refresh-live')).toBeUndefined()
    })
  })

  it('offers to use a newer Audiobookshelf position now and says when it moved', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00.000Z') })
    try {
      mocks.reconcile.mockResolvedValueOnce(makeLive())
      const lastUpdate = new Date('2026-10-07T11:55:00.000Z').getTime()
      const wrapper = mountStop(makeLink(), makeLive({ status: 'receiving', progress: { percentage: 50, isFinished: false, lastUpdate } }))

      expect(wrapper.get('[data-testid="edition-abs-status-hint"]').text()).toBe('Updated 5 minutes ago, picked up on the next sync.')
      expect(wrapper.find('[data-testid="edition-abs-reconcile-push"]').exists()).toBe(false)

      const button = wrapper.get('[data-testid="edition-abs-reconcile-pull"]')
      expect(button.text()).toBe('Use it now')
      await button.trigger('click')
      await flushPromises()

      expect(mocks.reconcile).toHaveBeenCalledWith('abs-1', 'pull')
      expect(wrapper.emitted('refresh-live')).toEqual([[makeLive()]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the live check when Audiobookshelf is unreachable', async () => {
    const wrapper = mountStop(makeLink(), makeLive({ status: 'unreachable', progress: null }))
    const retry = wrapper.get('[data-testid="edition-abs-retry"]')

    expect(retry.text()).toBe('Retry')
    await retry.trigger('click')

    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(wrapper.emitted('refresh-live')).toEqual([[]])
    expect(wrapper.get('[data-testid="edition-abs-retry"]').attributes('disabled')).toBeDefined()

    await wrapper.setProps({ live: makeLive({ status: 'unreachable', progress: null }) })
    expect(wrapper.get('[data-testid="edition-abs-retry"]').attributes('disabled')).toBeUndefined()
  })

  it('offers no action while a newer BookOrbit position is sending or when in sync', () => {
    for (const status of ['sending', 'synced'] as const) {
      const wrapper = mountStop(makeLink(), makeLive({ status }))
      expect(wrapper.find('[data-testid="edition-abs-reconcile-push"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-abs-reconcile-pull"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-abs-retry"]').exists()).toBe(false)
    }
  })

  it.each(['twoWay', 'status.unreachableHint', 'status.sendingHint', 'status.receivingHint'])('keeps the %s hint to one sentence', (key) => {
    const text = i18n.global.t(`book.detail.editionLink.abs.${key}`)
    expect(text.match(/[.!?](\s|$)/g)?.length ?? 0).toBe(1)
  })

  it.each(['fromAbs', 'toAbs'])('keeps the %s hint to a direction and a fix', (key) => {
    const text = i18n.global.t(`book.detail.editionLink.abs.${key}`)
    expect(text.match(/[.!?](\s|$)/g)?.length ?? 0).toBe(2)
  })
})
