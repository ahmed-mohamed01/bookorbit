import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MonitoredBulkRequestFormat, MonitoredWork } from '@bookorbit/types'
import type { SourceGroup } from '../composables/useRequestSources'
import { workFixture } from '../testing/work-fixture'
import MonitoredSelectionBar from './MonitoredSelectionBar.vue'

const passthrough = { template: '<div><slot /></div>' }

const works = [
  workFixture({ id: 'open' }),
  workFixture({ id: 'owned', ownedFormats: ['ebook'] }),
  workFixture({ id: 'requested', requestIds: { ebook: 1 }, requestStatuses: { ebook: 'downloading' } }),
  workFixture({ id: 'audio-only', ebookReleaseDate: null, ebookDatePrecision: null }),
]

function group(format: 'ebook' | 'audiobook', ticked: number[]): SourceGroup {
  const rows = [
    { id: 1, name: 'Genesis', delivery: 'file' as const, mediaKinds: [format] },
    { id: 2, name: 'Nyaa', delivery: 'torrent' as const, mediaKinds: [format] },
    { id: 3, name: 'MAM', delivery: 'usenet' as const, mediaKinds: [format] },
  ]
  const set = new Set(ticked)
  return { format, rows, ticked: set, locked: set.size === 1 ? (ticked[0] ?? null) : null }
}

function mountBar(props: { works?: MonitoredWork[]; format?: MonitoredBulkRequestFormat; running?: boolean; sourceGroups?: SourceGroup[] } = {}) {
  return mount(MonitoredSelectionBar, {
    props: { visible: true, works, format: 'ebook', autoDownload: true, running: false, sourceGroups: [], ...props },
    attachTo: document.body,
    global: {
      stubs: {
        Teleport: true,
        Transition: false,
        DropdownMenu: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: { template: '<button><slot /></button>' },
        DropdownMenuSeparator: true,
        DropdownMenuLabel: passthrough,
        Popover: passthrough,
        PopoverTrigger: passthrough,
        PopoverContent: passthrough,
      },
    },
  })
}

describe('MonitoredSelectionBar', () => {
  it('previews what will be requested and only the non-zero skip lines', () => {
    const wrapper = mountBar()

    expect(wrapper.get('[data-testid="bulk-request"]').text()).toBe('Get 1 ebook')
    expect(wrapper.get('[data-testid="bulk-will-request"]').text()).toBe('1 will be requested')
    expect(wrapper.get('[data-skip="owned"]').text()).toBe('1 already in library, skipped')
    expect(wrapper.get('[data-skip="requested"]').text()).toBe('1 already requested, skipped')
    expect(wrapper.get('[data-skip="no_ebook"]').text()).toBe('1 has no ebook edition, skipped')
    wrapper.unmount()
  })

  it('omits skip lines with a zero count', () => {
    const wrapper = mountBar({ works: [workFixture()] })

    expect(wrapper.findAll('[data-skip]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('changes the Get label with the chosen format', () => {
    expect(mountBar({ format: 'audiobook' }).get('[data-testid="bulk-request"]').text()).toBe('Get 4 audiobooks')
    expect(mountBar({ format: 'both' }).get('[data-testid="bulk-request"]').text()).toBe('Get 1 ebook and 4 audiobooks')
  })

  it('exposes the format switch as a radiogroup and emits the pick', async () => {
    const wrapper = mountBar()

    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(true)
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])

    await radios[2]!.trigger('click')

    expect(wrapper.emitted('update:format')?.[0]).toEqual(['both'])
    wrapper.unmount()
  })

  it('disables Get at zero and while running', () => {
    expect(
      mountBar({ works: [workFixture({ ownedFormats: ['ebook'] })] })
        .get('[data-testid="bulk-request"]')
        .attributes('disabled'),
    ).toBeDefined()
    expect(mountBar({ running: true }).get('[data-testid="bulk-request"]').attributes('disabled')).toBeDefined()
  })

  it('emits request when Get is clicked', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-testid="bulk-request"]').trigger('click')

    expect(wrapper.emitted('request')).toHaveLength(1)
    wrapper.unmount()
  })

  it('marks every selected book as the picked kind, without checking any choice', async () => {
    const wrapper = mountBar()
    const count = wrapper.props('works').length
    expect(wrapper.text()).toContain(`Mark ${count} books as`)
    expect(wrapper.text()).toContain('Anything other than Book moves them to Review and stops searching. Book brings them back.')
    expect(wrapper.find('[data-testid="mark-as-book"] svg.lucide-check').exists()).toBe(false)

    await wrapper.get('[data-testid="mark-as-split_part"]').trigger('click')
    expect(wrapper.emitted('patch')?.[0]).toEqual([{ kind: 'split_part' }])
    wrapper.unmount()
  })

  it('disables Mark as while a bulk request runs', () => {
    const wrapper = mountBar({ running: true })
    expect(wrapper.get('[data-testid="bulk-mark-as"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('hides the selection, and unhides when every work is already hidden', async () => {
    const wrapper = mountBar()
    expect(wrapper.get('[data-testid="bulk-hide"]').text()).toBe('Hide')

    await wrapper.get('[data-testid="bulk-hide"]').trigger('click')
    expect(wrapper.emitted('patch')?.[0]).toEqual([{ hidden: true }])
    wrapper.unmount()

    const hidden = mountBar({ works: [workFixture({ id: 'h', userVisibility: 'hidden' })] })
    expect(hidden.get('[data-testid="bulk-hide"]').text()).toBe('Unhide')

    await hidden.get('[data-testid="bulk-hide"]').trigger('click')
    expect(hidden.emitted('patch')?.[0]).toEqual([{ automaticVisibility: true }])
    hidden.unmount()
  })

  it('emits the watch patches from the Monitor menu', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-testid="bulk-watch-ebooks"]').trigger('click')
    await wrapper.get('[data-testid="bulk-unwatch-audiobooks"]').trigger('click')

    expect(wrapper.emitted('patch')).toEqual([[{ monitorEbook: true }], [{ monitorAudiobook: false }]])
    wrapper.unmount()
  })

  it('emits exit from the close button', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-testid="bulk-exit"]').trigger('click')

    expect(wrapper.emitted('exit')).toHaveLength(1)
    wrapper.unmount()
  })

  describe('sources', () => {
    it('is hidden when no source is listed', () => {
      const wrapper = mountBar()

      expect(wrapper.find('[data-testid="bulk-sources"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('says All when every source is on and counts the rows of the shown formats otherwise', () => {
      const all = mountBar({ sourceGroups: [group('ebook', [1, 2, 3])] })
      expect(all.get('[data-testid="bulk-sources"]').text()).toBe('Sources: All')
      expect(all.get('[data-testid="bulk-sources"]').attributes('aria-haspopup')).toBe('dialog')
      all.unmount()

      const some = mountBar({ format: 'both', sourceGroups: [group('ebook', [1, 2]), group('audiobook', [1, 2, 3])] })
      expect(some.get('[data-testid="bulk-sources"]').text()).toBe('Sources: 5 of 6')
      some.unmount()
    })

    it('renders one group per shown format with a checkbox per source and locks the last one', () => {
      const wrapper = mountBar({ format: 'both', sourceGroups: [group('ebook', [2]), group('audiobook', [1, 2, 3])] })

      expect(wrapper.findAll('[data-sources-group]').map((node) => node.attributes('data-sources-group'))).toEqual(['ebook', 'audiobook'])
      const ebook = wrapper.findAll('[data-sources-group="ebook"] input')
      expect(ebook.map((input) => (input.element as HTMLInputElement).checked)).toEqual([false, true, false])
      expect(ebook.map((input) => input.attributes('disabled') !== undefined)).toEqual([false, true, false])
      expect(wrapper.findAll('[data-sources-group="audiobook"] input[disabled]')).toHaveLength(0)
      expect(wrapper.get('[data-sources-group="ebook"]').text()).toContain('Direct')
      expect(wrapper.get('[data-sources-group="ebook"]').text()).toContain('Usenet')
      wrapper.unmount()
    })

    it('emits the toggled source and Use all', async () => {
      const wrapper = mountBar({ sourceGroups: [group('ebook', [1, 2, 3])] })

      await wrapper.get('[data-sources-group="ebook"] input[data-id="2"]').trigger('change')
      await wrapper.get('[data-testid="sources-use-all"]').trigger('click')

      expect(wrapper.emitted('toggleSource')?.[0]).toEqual(['ebook', 2])
      expect(wrapper.emitted('useAllSources')).toHaveLength(1)
      wrapper.unmount()
    })

    it('adds a footer line only for limited formats, and none while running', () => {
      const wrapper = mountBar({ format: 'both', sourceGroups: [group('ebook', [1, 3]), group('audiobook', [1, 2, 3])] })
      expect(wrapper.findAll('[data-source-line]').map((node) => node.text())).toEqual(['Ebooks from Genesis, MAM'])
      wrapper.unmount()

      const running = mountBar({ running: true, sourceGroups: [group('ebook', [1])] })
      expect(running.find('[data-testid="bulk-sources"]').exists()).toBe(false)
      running.unmount()
    })
  })
})
