import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Library } from '@bookorbit/types'
import { useLibraries } from '@/features/library/composables/useLibraries'
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

  it('toggles the chevron, aria-expanded and the open folder icon', async () => {
    const wrapper = mountTree()
    const toggle = wrapper.get('[data-testid="owned-toggle"]')

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="owned-chevron-right"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="owned-library-open"]').exists()).toBe(false)

    await toggle.trigger('click')

    const open = wrapper.get('[data-testid="owned-toggle"]')
    expect(open.attributes('aria-expanded')).toBe('true')
    expect(open.attributes('title')).toBe('/mnt/data/Fiction/Author/Title/Title.epub')
    expect(wrapper.find('[data-testid="owned-chevron-down"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="owned-library-open"]').exists()).toBe(true)
  })

  it('lists sibling files, capped, and groups subfolders', async () => {
    const siblings = Array.from({ length: 14 }, (_, n) => file(`/mnt/data/Fiction/Author/Title/extra${String(n).padStart(2, '0')}.jpg`))
    const nested = file('/mnt/data/Fiction/Author/Title/CD1/1.mp3')
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), ...siblings, nested] })
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    expect(wrapper.findAll('[data-testid="owned-sibling"]')).toHaveLength(12)
    expect(wrapper.get('[data-testid="owned-more"]').text()).toBe('+3 more files')
  })

  it('says "file" in the singular when one sibling is hidden', async () => {
    const siblings = Array.from({ length: 13 }, (_, n) => file(`/mnt/data/Fiction/Author/Title/extra${String(n).padStart(2, '0')}.jpg`))
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), ...siblings] })
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    expect(wrapper.get('[data-testid="owned-more"]').text()).toBe('+1 more file')
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
    expect(wrapper.emitted('update:expanded')).toEqual([[true]])
  })

  it('emphasises the primary file with a format pill and leaves siblings muted', async () => {
    const wrapper = mountTree({ files: [file('/mnt/data/Fiction/Author/Title/Title.epub'), file('/mnt/data/Fiction/Author/Title/cover.jpg')] })
    expect(wrapper.get('[data-testid="owned-primary"]').text().toUpperCase()).toContain('EPUB')
    await wrapper.get('[data-testid="owned-toggle"]').trigger('click')

    const primary = wrapper.get('[data-testid="owned-primary"]')
    expect(primary.classes()).toContain('text-foreground')
    expect(primary.get('[data-testid="owned-file"]').classes()).toContain('font-medium')
    expect(primary.findComponent({ name: 'BookFormatChip' }).exists()).toBe(true)
    const sibling = wrapper.get('[data-testid="owned-sibling"]')
    expect(sibling.classes()).toContain('text-muted-foreground')
    expect(sibling.findComponent({ name: 'BookFormatChip' }).exists()).toBe(false)
  })
})
