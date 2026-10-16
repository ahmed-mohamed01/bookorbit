import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredBulkRequestFormat, RequestSourceOption } from '@bookorbit/types'
import { useRequestSources } from './useRequestSources'

const api = vi.hoisted(() => ({ fetchRequestSources: vi.fn<() => Promise<RequestSourceOption[]>>() }))
vi.mock('../api/monitored', () => api)

const LIST: RequestSourceOption[] = [
  { id: 1, name: 'Genesis', delivery: 'file', mediaKinds: ['ebook'] },
  { id: 2, name: 'Nyaa', delivery: 'torrent', mediaKinds: ['ebook'] },
  { id: 3, name: 'MAM', delivery: 'torrent', mediaKinds: ['ebook', 'audiobook'] },
  { id: 4, name: 'ABB', delivery: 'torrent', mediaKinds: ['audiobook'] },
]

async function setup(initialFormat: MonitoredBulkRequestFormat = 'ebook') {
  const active = ref(false)
  const format = ref<MonitoredBulkRequestFormat>(initialFormat)
  let sources!: ReturnType<typeof useRequestSources>
  mount(
    defineComponent({
      setup() {
        sources = useRequestSources(active, format)
        return () => null
      },
    }),
  )
  return { active, format, sources }
}

async function open(active: { value: boolean }) {
  active.value = true
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useRequestSources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.fetchRequestSources.mockResolvedValue(LIST)
  })

  it('loads nothing until select mode opens, then only once', async () => {
    const { active, sources } = await setup()
    expect(api.fetchRequestSources).not.toHaveBeenCalled()

    await open(active)
    active.value = false
    await nextTick()
    await open(active)

    expect(api.fetchRequestSources).toHaveBeenCalledOnce()
    expect(sources.groups.value.map((group) => group.rows.map((row) => row.id))).toEqual([[1, 2, 3]])
  })

  it('hides the groups and omits sources when loading fails', async () => {
    api.fetchRequestSources.mockRejectedValue(new Error('403'))
    const { active, sources } = await setup()

    await open(active)

    expect(sources.groups.value).toEqual([])
    expect(sources.payloadFor(['ebook'])).toBeUndefined()
  })

  it('follows the format switch and lists a dual source in both groups', async () => {
    const { active, format, sources } = await setup()
    await open(active)

    format.value = 'both'
    await nextTick()

    expect(sources.groups.value.map((group) => [group.format, group.rows.map((row) => row.id)])).toEqual([
      ['ebook', [1, 2, 3]],
      ['audiobook', [3, 4]],
    ])
  })

  it('narrows a format and sends the ids, with null for a format left on all', async () => {
    const { active, format, sources } = await setup('both')
    await open(active)
    expect(sources.payloadFor(['ebook', 'audiobook'])).toEqual({ ebook: null, audiobook: null })

    sources.toggle('ebook', 2)

    expect(sources.groups.value[0]?.ticked).toEqual(new Set([1, 3]))
    expect(sources.payloadFor(['ebook', 'audiobook'])).toEqual({ ebook: [1, 3], audiobook: null })
    format.value = 'audiobook'
    await nextTick()
    expect(sources.payloadFor(['audiobook'])).toEqual({ audiobook: null })
  })

  it('returns to all when every source is ticked again', async () => {
    const { active, sources } = await setup()
    await open(active)

    sources.toggle('ebook', 2)
    sources.toggle('ebook', 2)

    expect(sources.payloadFor(['ebook'])).toEqual({ ebook: null })
  })

  it('never lets the last ticked source go', async () => {
    const { active, sources } = await setup()
    await open(active)
    sources.toggle('ebook', 1)
    sources.toggle('ebook', 2)

    expect(sources.groups.value[0]?.locked).toBe(3)
    sources.toggle('ebook', 3)

    expect(sources.groups.value[0]?.ticked).toEqual(new Set([3]))
    expect(sources.payloadFor(['ebook'])).toEqual({ ebook: [3] })
  })

  it('Use all and leaving select mode both reset the choice', async () => {
    const { active, sources } = await setup()
    await open(active)
    sources.toggle('ebook', 1)

    sources.useAll()
    expect(sources.payloadFor(['ebook'])).toEqual({ ebook: null })

    sources.toggle('ebook', 1)
    active.value = false
    await nextTick()
    expect(sources.payloadFor(['ebook'])).toEqual({ ebook: null })
  })
})
