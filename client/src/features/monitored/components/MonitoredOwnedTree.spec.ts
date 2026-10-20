import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Library } from '@bookorbit/types'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { formatBytes } from '@/lib/formatting'
import MonitoredOwnedTree from './MonitoredOwnedTree.vue'

const file = (path: string) => ({ absolutePath: path, filename: path.split('/').at(-1) })

function mountTree(props: Record<string, unknown> = {}) {
  return mount(MonitoredOwnedTree, {
    props: {
      format: 'ebook',
      libraryName: 'Fiction',
      libraryId: 3,
      fileName: 'Title.epub',
      filePath: '/mnt/data/Fiction/Author/Title/Title.epub',
      files: [file('/mnt/data/Fiction/Author/Title/Title.epub')],
      ...props,
    },
  })
}

describe('MonitoredOwnedTree', () => {
  beforeEach(() => {
    useLibraries().libraries.value = [
      { id: 3, name: 'Fiction', folders: [{ id: 1, path: '/mnt/data/Fiction', role: 'local' }] } as unknown as Library,
    ]
  })

  it('draws the path below the real library root without a placeholder', async () => {
    const wrapper = mountTree()
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    expect(wrapper.findAll('[data-testid="owned-folder"]').map((row) => row.text())).toEqual(['Author/', 'Title/'])
    expect(wrapper.text()).not.toContain('…')
  })

  it('falls back to the common prefix when the library root is unknown', async () => {
    const wrapper = mountTree({ libraryId: 99 })
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    expect(wrapper.findAll('[data-testid="owned-folder"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('…')
  })

  it('toggles aria-expanded and the open folder icon', async () => {
    const wrapper = mountTree()
    const toggle = wrapper.get('[data-testid="owned-toggle"]')

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="owned-library-closed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="owned-library-open"]').exists()).toBe(false)

    await toggle.trigger('click')

    const open = wrapper.get('[data-testid="owned-toggle"]')
    expect(open.attributes('aria-expanded')).toBe('true')
    expect(open.attributes('title')).toBe('/mnt/data/Fiction/Author/Title/Title.epub')
    expect(wrapper.find('[data-testid="owned-library-closed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="owned-library-open"]').exists()).toBe(true)
  })

  it('offers the re-check button only when the page allows one', async () => {
    const plain = mountTree()
    expect(plain.find('[data-testid="owned-recheck"]').exists()).toBe(false)

    const wrapper = mountTree({ recheckable: true })
    const recheck = wrapper.get('[data-testid="owned-recheck"]')
    expect(recheck.attributes('title')).toBe('Re-check files on disk')
    expect(recheck.find('svg').classes()).not.toContain('motion-safe:animate-spin')

    await recheck.trigger('click')
    expect(wrapper.emitted('recheck')).toHaveLength(1)

    const busy = mountTree({ recheckable: true, checking: true })
    expect(busy.get('[data-testid="owned-recheck"]').find('svg').classes()).toContain('motion-safe:animate-spin')
  })

  it('caps the collapsed list and expands it behind "Show all N files"', async () => {
    const siblings = ['a.epub', 'b.epub', 'c.epub', 'd.epub'].map((name) => file(`/mnt/data/Fiction/Author/Title/${name}`))
    const wrapper = mountTree({
      files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), ...siblings, file('/mnt/data/Fiction/Author/Title/cover.jpg')],
    })

    const collapsedRows = wrapper.findAll('[data-testid="owned-primary"], [data-testid="owned-sibling"]')
    expect(collapsedRows).toHaveLength(3)
    const more = wrapper.get('[data-testid="owned-more"]')
    expect(more.text()).toContain('Show all 5 files')
    expect(more.text()).toContain('cover.jpg')

    await wrapper.get('[data-testid="owned-more-toggle"]').trigger('click')

    expect(wrapper.findAll('[data-testid="owned-primary"], [data-testid="owned-sibling"]')).toHaveLength(6)
    expect(wrapper.get('[data-testid="owned-more"]').text()).toContain('Show fewer files')
  })

  it('counts only the hidden files when nothing but artwork is out of sight', async () => {
    const artwork = ['cover.jpg', 'back.jpg', 'spine.jpg'].map((name) => file(`/mnt/data/Fiction/Author/Title/${name}`))
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), ...artwork] })

    expect(wrapper.get('[data-testid="owned-more"]').text()).toContain('Show 1 more file')
  })

  it('offers no "Show all" line when the collapsed list already shows every file', () => {
    const wrapper = mountTree({
      files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), file('/mnt/data/Fiction/Author/Title/Extras/booklet.pdf')],
    })

    expect(wrapper.find('[data-testid="owned-more"]').exists()).toBe(false)
  })

  it('cannot start a second re-check while one runs', () => {
    const wrapper = mountTree({ recheckable: true, checking: true })

    expect(wrapper.get('[data-testid="owned-recheck"]').attributes('disabled')).toBeDefined()
  })

  it('shows a nested file under its subfolder line', async () => {
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), file('/mnt/data/Fiction/Author/Title/CD1/1.mp3')] })
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    expect(wrapper.get('[data-testid="owned-subfolder"]').text()).toBe('CD1/')
    expect(wrapper.get('[data-testid="owned-sibling"]').text()).toBe('1.mp3')
  })

  it('labels the library line as the way to the full path', async () => {
    const wrapper = mountTree()
    expect(wrapper.get('[data-testid="owned-path"]').text()).toBe('Full path')
    expect(wrapper.get('[data-testid="owned-path"]').classes()).toContain('text-muted-foreground')
    expect(wrapper.get('[data-testid="owned-path"]').attributes('title')).toBe('/mnt/data/Fiction/Author/Title')
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="owned-path"]').text()).toBe('Hide path')
  })

  it('emphasises the primary file and leaves siblings muted, with the format left to the stat line', async () => {
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), file('/mnt/data/Fiction/Author/Title/cover.jpg')] })
    expect(wrapper.findComponent({ name: 'BookFormatChip' }).exists()).toBe(false)
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    const primary = wrapper.get('[data-testid="owned-primary"]')
    expect(primary.classes()).toContain('text-foreground')
    expect(primary.get('[data-testid="owned-file"]').classes()).toContain('font-medium')
    const sibling = wrapper.get('[data-testid="owned-sibling"]')
    expect(sibling.classes()).toContain('text-muted-foreground')
    expect(sibling.findComponent({ name: 'BookFormatChip' }).exists()).toBe(false)
  })

  it('sizes every file whose size is known', () => {
    const primary = { ...file('/mnt/data/Fiction/Author/Title/Title.epub'), sizeBytes: 2400 }
    const sibling = { ...file('/mnt/data/Fiction/Author/Title/cover.jpg'), sizeBytes: null }
    const wrapper = mountTree({ files: [primary, sibling] })

    expect(wrapper.get('[data-testid="owned-primary"]').text()).toContain(formatBytes(2400))
    expect(wrapper.get('[data-testid="owned-sibling"]').find('[data-testid="owned-size"]').exists()).toBe(false)
  })

  it('totals an audiobook behind the "Show all" line', () => {
    const files = [
      { ...file('/mnt/data/Fiction/Author/Title/Title.m4b'), sizeBytes: 900_000, durationSeconds: 3600 },
      ...['a.m4b', 'b.m4b', 'c.m4b', 'd.m4b'].map((name, n) => ({
        ...file(`/mnt/data/Fiction/Author/Title/${name}`),
        sizeBytes: 800_000,
        durationSeconds: 60 * (n + 1),
      })),
    ]
    const wrapper = mountTree({
      format: 'audiobook',
      fileName: 'Title.m4b',
      filePath: '/mnt/data/Fiction/Author/Title/Title.m4b',
      files,
    })

    const more = wrapper.get('[data-testid="owned-more"]')
    expect(more.text()).toContain('Show all 5 files')
    expect(more.text()).toContain('1 h 10 min')

    const withoutCap = mountTree({
      format: 'audiobook',
      fileName: 'Title.m4b',
      filePath: '/mnt/data/Fiction/Author/Title/Title.m4b',
      files: [files[0]],
    })
    const line = withoutCap.get('[data-testid="owned-more"]')
    expect(line.text()).toBe('1 h 0 min')
    expect(line.find('[data-testid="owned-more-toggle"]').exists()).toBe(false)
  })

  it('puts the action slot in place of the re-check icon', () => {
    const wrapper = mount(MonitoredOwnedTree, {
      props: { format: 'ebook', libraryName: 'Fiction', libraryId: 3, fileName: 'Title.epub', recheckable: true },
      slots: { action: '<button data-testid="slot-action">Fix match</button>' },
    })

    expect(wrapper.find('[data-testid="owned-recheck"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="slot-action"]').text()).toBe('Fix match')
  })
})
