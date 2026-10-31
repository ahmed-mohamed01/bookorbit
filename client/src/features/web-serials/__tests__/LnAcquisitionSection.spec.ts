import { beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { Permission } from '@bookorbit/types'
import { i18n } from '@/i18n'
import LnAcquisitionSection from '../components/preview/LnAcquisitionSection.vue'
import { useLightNovelAcquisition } from '../composables/useLightNovelAcquisition'
import { catalogEntry } from './fixtures'

const access = vi.hoisted(() => ({ manage: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: (permission: Permission) => permission === Permission.ManageBookRequests && access.manage }),
}))
vi.mock('../composables/useLightNovelAcquisition', () => ({ useLightNovelAcquisition: vi.fn<(...args: unknown[]) => void>() }))
const closeDraft = vi.fn<(...args: unknown[]) => void>()
const requestVolumes = vi.fn<(...args: unknown[]) => void>()
const cancelRequest = vi.fn<(...args: unknown[]) => void>()
beforeEach(() => {
  vi.clearAllMocks()
  access.manage = true
  vi.mocked(useLightNovelAcquisition).mockReturnValue({
    state: ref({
      volumes: [{ volume: 1, state: 'missing', bookId: null, error: null }],
      downloads: [],
      role: 'approver',
      bookRequestId: 2,
      seriesRequestId: 1,
    }),
    volumeFilter: ref(new Set([1])),
    toggleVolume: vi.fn<(...args: unknown[]) => void>(),
    showMissingOnly: vi.fn<(...args: unknown[]) => void>(),
    clearFilter: vi.fn<(...args: unknown[]) => void>(),
    query: ref({ title: 'Novel', author: '' }),
    searchWith: vi.fn<(query: { title: string; author: string }) => Promise<void>>(),
    search: {
      status: ref('ready'),
      indexers: ref([{ indexerId: 1, indexerName: 'Direct', delivery: 'file', ok: true, count: 1, filtered: 0, seedsBack: false, color: null }]),
      pending: ref([]),
      results: ref([]),
      run: vi.fn<(...args: unknown[]) => void>(),
    },
    suggestion: ref(null),
    pickSuggestion: vi.fn<(...args: unknown[]) => void>(),
    releases: ref([
      {
        indexerId: 1,
        guid: 'one',
        vipOnly: true,
        title: 'Novel Vol. 1',
        indexerName: 'Direct',
        volumes: [1],
        kind: null,
        score: 90,
        tier: null,
        sizeBytes: null,
        seeders: null,
        fileCount: 1,
      },
    ]),
    picks: ref(new Set()),
    togglePick: vi.fn<(...args: unknown[]) => void>(),
    fileSelection: ref(new Map()),
    inspect: vi.fn<(...args: unknown[]) => void>(),
    inspections: ref(new Map()),
    inspecting: ref(new Set()),
    inspectionErrors: ref(new Map()),
    plannedVolumes: ref(new Map()),
    bar: ref({ volumes: [], volumeCount: 0, releaseCount: 0, sizeBytes: 0, canSend: false }),
    clients: ref([]),
    clientId: ref(null),
    send: vi.fn<(...args: unknown[]) => void>(),
    downloads: ref([]),
    closeDraft,
    refresh: vi.fn<(...args: unknown[]) => void>(),
    error: ref(null),
    sending: ref(false),
    typedCount: ref(null),
    requesting: ref(false),
    requestVolumes,
    cancelRequest,
  } as unknown as ReturnType<typeof useLightNovelAcquisition>)
})
function render() {
  return mount(LnAcquisitionSection, {
    props: { series: { ...catalogEntry({ kind: 'novel' }), publication: { licensed: true, finalVolume: 1, publishers: [] } }, open: true },
    global: { plugins: [i18n] },
  })
}
it('uses the source delivery and closes the draft when the sheet closes', async () => {
  const wrapper = render()
  expect(wrapper.text()).toContain(i18n.global.t('bookRequests.releases.protocol.directPill'))
  expect(wrapper.text()).not.toContain(i18n.global.t('bookRequests.releases.protocol.torrent'))
  await wrapper.setProps({ open: false })
  expect(closeDraft).toHaveBeenCalledOnce()
  wrapper.unmount()
})
it('renders the requester panel and passes selected volumes to its request action', async () => {
  access.manage = false
  const wrapper = render()
  expect(wrapper.text()).not.toContain('Direct')
  const button = wrapper.findAll('button').find((button) => button.text() === i18n.global.t('webSerials.acquisition.requestVolumes', 1))!
  await button.trigger('click')
  expect(requestVolumes).toHaveBeenCalledWith([1])
  const options = vi.mocked(useLightNovelAcquisition).mock.calls[0]![1]
  expect(typeof options.role === 'object' && options.role.value).toBe('requester')
  wrapper.unmount()
})

it('allows VIP releases to be selected', async () => {
  const wrapper = render()
  const row = wrapper.findComponent({ name: 'LnReleaseRow' })
  expect(row.props('blocked')).toBeFalsy()
  wrapper.unmount()
})

it('shows per-pick failures even with View files collapsed', async () => {
  const wrapper = render()
  const flow = vi.mocked(useLightNovelAcquisition).mock.results[0]!.value as ReturnType<typeof useLightNovelAcquisition>
  flow.inspectionErrors.value.set('1:one', new Error('Release refused'))
  await nextTick()
  expect(wrapper.get('[role="alert"]').text()).toBe('Release refused')
  wrapper.unmount()
})

it('passes custom searches from the strip to the acquisition flow', async () => {
  const wrapper = render()
  await wrapper.get('input[maxlength="500"]').setValue('Romaji')
  await wrapper.get('form').trigger('submit')
  const flow = vi.mocked(useLightNovelAcquisition).mock.results[0]!.value as ReturnType<typeof useLightNovelAcquisition>
  expect(flow.searchWith).toHaveBeenCalledWith({ title: 'Romaji', author: '' })
})
it('keeps unmatched releases selectable in a collapsed disclosure and places the torrent selector in the footer', async () => {
  const flow = vi.mocked(useLightNovelAcquisition).getMockImplementation()!(ref(null), { role: 'approver', canManage: true })
  flow.releases.value.push({ ...flow.releases.value[0]!, guid: 'unmatched', title: 'My Sony Library part A-B', volumes: [], score: 0 })
  const torrentPicks = ref(true)
  Object.assign(flow, {
    needsClient: torrentPicks,
    clients: ref([{ id: 5, name: 'Qbit', color: null, delivery: 'torrent', fileSelection: true }]),
  })
  vi.mocked(useLightNovelAcquisition).mockReturnValue(flow)
  const wrapper = render()
  const disclosure = wrapper.get('details')
  expect(disclosure.attributes('open')).toBeUndefined()
  expect(disclosure.get('summary').text()).toBe('Unmatched results (1)')
  expect(disclosure.text()).toContain('My Sony Library part A-B')
  await disclosure.get('button[aria-pressed]').trigger('click')
  expect(flow.togglePick).toHaveBeenCalledWith(expect.objectContaining({ guid: 'unmatched' }))
  expect(wrapper.find('footer select').exists()).toBe(true)
  torrentPicks.value = false
  await nextTick()
  expect(wrapper.find('select').exists()).toBe(false)
  wrapper.unmount()
})
