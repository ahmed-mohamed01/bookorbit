import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive } from '@bookorbit/types'
import AudiobookshelfSyncStop from '../AudiobookshelfSyncStop.vue'
import { withMessages } from './with-messages'

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } }

function makeLink(overrides: Partial<AudiobookshelfBookSyncLink> = {}): AudiobookshelfBookSyncLink {
  return {
    audioBookId: 20,
    absLibraryItemId: 'abs-1',
    title: 'Dune',
    authorName: 'Frank Herbert',
    libraryName: 'Fiction',
    direction: 'two_way',
    webUrl: 'https://abs.example.com/item/abs-1',
    ...overrides,
  }
}

function makeLive(overrides: Partial<AudiobookshelfBookSyncLive> = {}): AudiobookshelfBookSyncLive {
  return { status: 'synced', progress: { percentage: 42.4, isFinished: false, lastUpdate: 5000 }, ...overrides }
}

function mountStop(link = makeLink(), live: AudiobookshelfBookSyncLive | null = makeLive(), checking = false) {
  return mount(AudiobookshelfSyncStop, {
    props: { link, live, checking, merged: true, connectorPlacement: 'left-5 size-5', position: 'middle' },
    global: { stubs },
  })
}

describe('AudiobookshelfSyncStop', () => {
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
})
