import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BatchSelectionBar from '../components/BatchSelectionBar.vue'
const props = { count: 0, sizeBytes: 0, totalBytes: 1024, clients: [], clientId: null, sending: false }
const mountPanel = () => mount(BatchSelectionBar, { props })
describe('BatchSelectionBar', () => {
  it('disables the button with nothing selected and shows the singular label for one book', async () => {
    const wrapper = mount(BatchSelectionBar, { props })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button').text()).toBe('Select a book to download')
    await wrapper.setProps({ count: 1 })
    expect(wrapper.get('button').text()).toBe('Download 1 book')
  })
  it('says nothing is selected instead of showing zero bytes', async () => {
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('No books selected · 1 kB in this release')
    expect(wrapper.text()).not.toContain('0 byte')
    await wrapper.setProps({ count: 2, sizeBytes: 512 })
    expect(wrapper.text()).toContain('2 books · 512 byte of 1 kB')
  })
  it('lists only clients that can skip files', () => {
    const clients = [
      { id: 1, name: 'qBittorrent', color: null, delivery: 'torrent' as const, fileSelection: true },
      { id: 2, name: 'Other', color: null, delivery: 'torrent' as const, fileSelection: false },
    ]
    const wrapper = mount(BatchSelectionBar, { props: { ...props, clients } })
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual(['qBittorrent'])
  })
})
