import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { Permission } from '@bookorbit/types'
import type { BookRequestItem, BookRequestStatus, MetadataCandidate, ReleaseCandidateItem } from '@bookorbit/types'
import type { PublishedSeries } from '../lib/publishedVolumes'
import type { VolumeCandidatePick } from '../lib/publishedVolumeMatch'
import { catalogEntry } from './fixtures'

const api = vi.hoisted(() => ({
  fetchRequestSourceStatus: vi.fn<() => Promise<{ configured: number; enabled: number }>>(),
  fetchPublishedRequests: vi.fn<(kind: string, matchId: string) => Promise<{ volume: string; bookRequestId: number }[]>>(),
  fetchBookRequest: vi.fn<(id: number) => Promise<BookRequestItem | null>>(),
  recordPublishedRequest: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  createVolumeRequest: vi.fn<(payload: Record<string, unknown>) => Promise<{ request: BookRequestItem; subscribed: boolean }>>(),
  cancelVolumeRequest: vi.fn<(id: number) => Promise<BookRequestItem>>(),
  fetchRequestReleases: vi.fn<(id: number) => Promise<{ releases: ReleaseCandidateItem[] }>>(),
  grabRequestRelease: vi.fn<(id: number, indexerId: number, guid: string) => Promise<BookRequestItem>>(),
}))
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }))
const match = vi.hoisted(() => ({
  resolveVolume: vi.fn<(series: PublishedSeries, volume: number) => Promise<VolumeCandidatePick | null>>(),
  providerLabel: vi.fn<(provider: string) => string>((provider) => provider),
}))

vi.mock('../api/bookRequests', () => api)
vi.mock('../api/webSerials', () => ({
  fetchCapabilities: vi.fn<() => Promise<unknown>>().mockResolvedValue({
    manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
    novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
  }),
}))
vi.mock('../composables/useWebSerialVolumeMatch', () => ({ useWebSerialVolumeMatch: () => match }))
vi.mock('@/features/book-requests/composables/useRequestDestinationDefault', () => ({
  useRequestLanguageDefault: () => ({ load: vi.fn<() => Promise<boolean>>().mockResolvedValue(true), resolveLanguage: () => 'en' }),
}))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  return { useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }) }
})
vi.mock('@/features/auth/composables/useAuth', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ user: ref({ id: 7 }) }) }
})
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: (name: string) => permissions.granted.has(name) }),
}))
vi.mock('@/components/ui/ConfirmDialog.vue', async () => {
  const { defineComponent: vueDefineComponent, h: vueH } = await import('vue')
  return {
    default: vueDefineComponent({
      props: { open: Boolean, title: String, description: String, confirmLabel: String, busy: Boolean, destructive: Boolean },
      emits: ['confirm', 'cancel'],
      setup(props, { emit }) {
        return () =>
          props.open
            ? vueH('div', { 'data-testid': 'rematch-dialog' }, [
                vueH('p', {}, props.description),
                vueH('button', { 'data-testid': 'rematch-dialog-confirm', onClick: () => emit('confirm') }, props.confirmLabel),
              ])
            : null
      },
    }),
  }
})

import WebSerialPublishedVolumes from '../components/preview/WebSerialPublishedVolumes.vue'
import WebSerialEntryPreview from '../components/WebSerialEntryPreview.vue'

const RouterLinkStub = defineComponent({
  props: { to: { type: Object, required: true } },
  setup(props, { slots }) {
    return () => h('a', { 'data-to': JSON.stringify(props.to) }, slots.default?.())
  },
})

function series(overrides: Partial<PublishedSeries> = {}): PublishedSeries {
  return {
    kind: 'novel',
    matchId: '1234',
    title: 'Spice and Wolf',
    authors: ['Isuna Hasekura'],
    url: 'https://mangabaka.org/1234',
    publication: { licensed: true, finalVolume: 3, publishers: [{ name: 'Yen Press', type: 'English', language: 'en' }] },
    ...overrides,
  }
}

/** Seeds the recorded ids for the series and the per-id status reads behind them. */
function seedRequests(items: BookRequestItem[]) {
  api.fetchPublishedRequests.mockResolvedValue(items.map((entry) => ({ volume: String(entry.seriesIndex), bookRequestId: entry.id })))
  api.fetchBookRequest.mockImplementation((id) => Promise.resolve(items.find((entry) => entry.id === id) ?? null))
}

function item(id: number, seriesIndex: number, status: BookRequestStatus): BookRequestItem {
  return {
    id,
    userId: 7,
    seriesIndex,
    seriesName: 'Spice and Wolf',
    mediaKind: 'ebook',
    status,
    title: `Spice and Wolf Vol. ${seriesIndex}`,
  } as BookRequestItem
}

/** A request the old free-text path would have made: no provider record or ISBN behind it. */
function freeTextItem(id: number, seriesIndex: number, status: BookRequestStatus): BookRequestItem {
  return { ...item(id, seriesIndex, status), providerId: null, providerKey: null, isbn13: null, isbn10: null }
}

function matchedItem(id: number, seriesIndex: number, status: BookRequestStatus): BookRequestItem {
  return { ...item(id, seriesIndex, status), providerId: `g${seriesIndex}`, providerKey: 'google', isbn13: null, isbn10: null }
}

function release(overrides: Partial<ReleaseCandidateItem> = {}): ReleaseCandidateItem {
  return {
    indexerId: 2,
    indexerName: 'Tracker',
    guid: 'g1',
    title: 'Spice and Wolf v02 (2009)',
    sizeBytes: 2048,
    seeders: 5,
    ...overrides,
  } as ReleaseCandidateItem
}

/** The volume's real book, as the provider search would hand it back. */
function pick(volume: number): VolumeCandidatePick {
  const candidate = {
    provider: 'google',
    providerId: `g${volume}`,
    displayTitle: `Spice and Wolf: Volume ${volume}`,
    authors: ['Isuna Hasekura'],
    language: 'en',
    seriesIndex: String(volume),
  } as MetadataCandidate
  return { candidate, score: 78, accepted: [candidate] }
}

async function render(reason: 'licensed' | 'unavailable' | null = 'licensed', value: PublishedSeries = series()) {
  const wrapper = mount(WebSerialPublishedVolumes, { props: { series: value, reason }, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  permissions.granted = new Set([Permission.BookRequestAccess])
  api.fetchRequestSourceStatus.mockResolvedValue({ configured: 1, enabled: 1 })
  seedRequests([])
  api.recordPublishedRequest.mockResolvedValue(undefined)
  match.resolveVolume.mockResolvedValue(null)
})

describe('WebSerialPublishedVolumes visibility', () => {
  it('shows a licensed series with its publishers and one row per volume', async () => {
    const wrapper = await render('licensed')
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('licensed in print')
    expect(wrapper.text()).toContain('Yen Press')
    expect(wrapper.findAll('[data-testid="published-volume"]')).toHaveLength(3)
  })

  it('explains itself differently when no source has the series', async () => {
    const wrapper = await render('unavailable')
    expect(wrapper.text()).toContain('None of your sources carry this series')
  })

  it('is hidden when there is no reason to offer it', async () => {
    const wrapper = await render(null)
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(false)
  })

  it('is hidden without the request permission', async () => {
    permissions.granted = new Set()
    const wrapper = await render('licensed')
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(false)
  })

  it('is hidden when Book Requests has no enabled source', async () => {
    api.fetchRequestSourceStatus.mockResolvedValue({ configured: 0, enabled: 0 })
    const wrapper = await render('licensed')
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(false)
  })

  it('asks for a count when the series database has no final volume', async () => {
    const wrapper = await render('licensed', series({ publication: { licensed: true, finalVolume: null, publishers: [] } }))
    expect(wrapper.findAll('[data-testid="published-volume"]')).toHaveLength(0)
    const input = wrapper.get('#web-serial-published-count')
    await input.setValue('4')
    expect(wrapper.findAll('[data-testid="published-volume"]')).toHaveLength(4)
  })
})

describe('WebSerialPublishedVolumes rows', () => {
  it('links a requested volume to its request and offers Request on the rest', async () => {
    seedRequests([item(11, 2, 'approved')])
    const wrapper = await render()
    const rows = wrapper.findAll('[data-testid="published-volume"]')

    expect(rows[1]!.get('a').attributes('data-to')).toBe(JSON.stringify({ name: 'book-request-detail', params: { id: 11 } }))
    expect(rows[1]!.find('[data-testid="request-volume"]').exists()).toBe(false)
    expect(rows[0]!.find('[data-testid="request-volume"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="request-all"]').text()).toContain('2')
  })

  it('requests the published book a volume resolves to, and names it under the volume', async () => {
    match.resolveVolume.mockResolvedValue(pick(1))
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(21, 1, 'pending'), subscribed: false })
    const wrapper = await render()
    await wrapper.findAll('[data-testid="request-volume"]')[0]!.trigger('click')
    await flushPromises()

    expect(api.createVolumeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Spice and Wolf: Volume 1', providerKey: 'google', providerId: 'g1', seriesIndex: 1 }),
    )
    expect(wrapper.findAll('[data-testid="published-volume"]')[0]!.find('a').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="published-volume"]')[0]!.get('[data-testid="published-matched-title"]').text()).toBe(
      'Spice and Wolf: Volume 1',
    )
  })

  it('names the book behind an existing matched request without searching again', async () => {
    seedRequests([{ ...matchedItem(11, 2, 'approved'), title: 'Spice and Wolf: Volume 2' }])
    const wrapper = await render()

    expect(match.resolveVolume).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-testid="published-volume"]')[1]!.get('[data-testid="published-matched-title"]').text()).toBe(
      'Spice and Wolf: Volume 2',
    )
  })

  it('offers the Requests page when no published book matches, then a free-text fallback', async () => {
    const wrapper = await render()
    await wrapper.findAll('[data-testid="request-volume"]')[0]!.trigger('click')
    await flushPromises()

    const row = wrapper.findAll('[data-testid="published-volume"]')[0]!
    expect(api.createVolumeRequest).not.toHaveBeenCalled()
    expect(row.get('[data-testid="published-no-match"]').text()).toContain('No published match found.')
    expect(row.get('[data-testid="published-no-match"] a').attributes('data-to')).toBe(JSON.stringify({ name: 'book-requests' }))

    api.createVolumeRequest.mockResolvedValue({ request: item(22, 1, 'pending'), subscribed: false })
    await row.get('[data-testid="request-anyway"]').trigger('click')
    await flushPromises()

    expect(api.createVolumeRequest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Spice and Wolf Vol. 1', seriesIndex: 1 }))
    expect(row.find('[data-testid="published-no-match"]').exists()).toBe(false)
  })

  it('keeps Request anyway disabled while Request all is running', async () => {
    match.resolveVolume.mockImplementation((_series, volume) => (volume === 1 ? Promise.resolve(null) : new Promise(() => undefined)))
    const wrapper = await render()

    await wrapper.get('[data-testid="request-all"]').trigger('click')
    await flushPromises()

    const anyway = wrapper.findAll('[data-testid="published-volume"]')[0]!.get('[data-testid="request-anyway"]')
    expect(anyway.attributes('disabled')).toBeDefined()
  })

  it('re-matches a free-text request and replaces it after a confirm', async () => {
    seedRequests([freeTextItem(11, 2, 'pending')])
    match.resolveVolume.mockResolvedValue(pick(2))
    const wrapper = await render()
    const row = wrapper.findAll('[data-testid="published-volume"]')[1]!

    await row.get('[data-testid="rematch-volume"]').trigger('click')
    await flushPromises()

    expect(api.cancelVolumeRequest).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="rematch-dialog"]').text()).toContain('Spice and Wolf Vol. 2')
    expect(wrapper.get('[data-testid="rematch-dialog"]').text()).toContain('Spice and Wolf: Volume 2')

    api.cancelVolumeRequest.mockResolvedValue(freeTextItem(11, 2, 'cancelled'))
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(31, 2, 'pending'), subscribed: false })
    await wrapper.get('[data-testid="rematch-dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(api.cancelVolumeRequest).toHaveBeenCalledWith(11)
    expect(api.createVolumeRequest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Spice and Wolf: Volume 2', providerId: 'g2' }))
    expect(api.recordPublishedRequest).toHaveBeenCalledWith(expect.objectContaining({ volume: '2', bookRequestId: 31 }))
    expect(wrapper.find('[data-testid="rematch-dialog"]').exists()).toBe(false)
  })

  it('offers no re-match on a request that can no longer be cancelled or that someone else made', async () => {
    seedRequests([freeTextItem(11, 1, 'available'), { ...freeTextItem(12, 2, 'pending'), userId: 8 }, freeTextItem(13, 3, 'pending')])
    const wrapper = await render()
    const rows = wrapper.findAll('[data-testid="published-volume"]')

    expect(rows[0]!.find('[data-testid="rematch-volume"]').exists()).toBe(false)
    expect(rows[1]!.find('[data-testid="rematch-volume"]').exists()).toBe(false)
    expect(rows[2]!.find('[data-testid="rematch-volume"]').exists()).toBe(true)
  })

  it('offers no re-match once a provider record backs the request', async () => {
    seedRequests([matchedItem(11, 2, 'approved')])
    const wrapper = await render()

    expect(wrapper.findAll('[data-testid="published-volume"]')[1]!.find('[data-testid="rematch-volume"]').exists()).toBe(false)
  })

  it('shows Find releases only to managers', async () => {
    seedRequests([item(11, 2, 'approved')])
    const plain = await render()
    expect(plain.find('[data-testid="find-releases"]').exists()).toBe(false)

    permissions.granted = new Set([Permission.BookRequestAccess, Permission.ManageBookRequests])
    const manager = await render()
    expect(manager.findAll('[data-testid="find-releases"]')).toHaveLength(1)
  })

  it('lists releases inline and grabs the one picked', async () => {
    permissions.granted = new Set([Permission.BookRequestAccess, Permission.ManageBookRequests])
    seedRequests([item(11, 2, 'approved')])
    api.fetchRequestReleases.mockResolvedValue({ releases: [release()] })
    api.grabRequestRelease.mockResolvedValue(item(11, 2, 'grabbed'))
    const wrapper = await render()

    await wrapper.get('[data-testid="find-releases"]').trigger('click')
    await flushPromises()
    const releaseRow = wrapper.get('[data-testid="published-release"]')
    expect(releaseRow.text()).toContain('Spice and Wolf v02 (2009)')
    expect(releaseRow.text()).toContain('Tracker')
    expect(releaseRow.text()).toContain('5 seeders')

    await releaseRow.get('button').trigger('click')
    await flushPromises()
    expect(api.grabRequestRelease).toHaveBeenCalledWith(11, 2, 'g1')
    expect(wrapper.find('[data-testid="published-release"]').exists()).toBe(false)
  })
})

describe('WebSerialEntryPreview published volumes', () => {
  const props = { open: true, options: [], failedSources: [], error: null, selectedKey: '' }

  it('offers the volumes when no source carries the series', async () => {
    const wrapper = mount(WebSerialEntryPreview, {
      props: { ...props, entry: catalogEntry(), state: 'none' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(true)
  })

  it('offers them as the main panel only once no source carries the series', async () => {
    const entry = catalogEntry({ publication: { licensed: true, finalVolume: 2, publishers: [] } })
    const finding = mount(WebSerialEntryPreview, { props: { ...props, entry, state: 'finding' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    const none = mount(WebSerialEntryPreview, { props: { ...props, entry, state: 'none' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(finding.find('[data-testid="published-volumes"]').exists()).toBe(false)
    expect(none.find('[data-testid="published-volumes"]').exists()).toBe(true)
  })
})
