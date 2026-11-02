import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SyncIssueMenu from '../SyncIssueMenu.vue'

// The menu is generic over its action ids, so its props come from the component function rather than an instance.
type MenuProps = Parameters<typeof SyncIssueMenu>[0]

function mountMenu(props: Partial<MenuProps> = {}, slots: Record<string, string> = {}) {
  return mount(SyncIssueMenu, {
    attachTo: document.body,
    props: { tone: 'warning', icon: 'alert', title: 'Couldn’t index', ...props } as MenuProps,
    slots,
  })
}

function content(): HTMLElement | null {
  return document.body.querySelector('[data-testid="sync-issue-content"]')
}

async function open(wrapper: ReturnType<typeof mountMenu>) {
  await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
  await flushPromises()
}

describe('SyncIssueMenu', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('names the icon button after the problem and tints it by tone', () => {
    const wrapper = mountMenu({ tone: 'destructive' })
    const trigger = wrapper.get('[data-testid="sync-issue-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('Couldn’t index')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.classes()).toContain('text-destructive')
    expect(content()).toBeNull()
  })

  it('opens a dropdown with the title, the explanation and the fixes, the first one primary', async () => {
    const wrapper = mountMenu({
      detail: 'No audio stream found in chapter 12.',
      actions: [
        { id: 'retry', label: 'Retry indexing' },
        { id: 'other', label: 'Other' },
      ],
    })
    await open(wrapper)

    expect(wrapper.get('[data-testid="sync-issue-trigger"]').attributes('aria-expanded')).toBe('true')
    expect(content()?.querySelector('[data-testid="sync-issue-title"]')?.textContent).toContain('Couldn’t index')
    expect(content()?.querySelector('[data-testid="sync-issue-detail"]')?.textContent).toContain('chapter 12')
    const buttons = [...(content()?.querySelectorAll<HTMLButtonElement>('[data-testid="sync-issue-action"]') ?? [])]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Retry indexing', 'Other'])
    expect(buttons[0]!.className).toContain('bg-primary')
    expect(buttons[1]!.className).toContain('border')
  })

  it('emits the fix and closes after it is pressed', async () => {
    const wrapper = mountMenu({ actions: [{ id: 'retry', label: 'Retry indexing' }] })
    await open(wrapper)
    content()?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click()
    await flushPromises()

    expect(wrapper.emitted('action')).toEqual([['retry']])
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    expect(content()).toBeNull()
  })

  it('stays open for an action that swaps in more content', async () => {
    const wrapper = mountMenu({ actions: [{ id: 'change', label: 'Change match', keepOpen: true }] })
    await open(wrapper)
    content()?.querySelector<HTMLButtonElement>('[data-action="change"]')?.click()
    await flushPromises()

    expect(wrapper.emitted('action')).toEqual([['change']])
    expect(content()).not.toBeNull()
  })

  it('disables the fixes while busy and closes on Escape', async () => {
    const wrapper = mountMenu({ busy: true, actions: [{ id: 'retry', label: 'Retry indexing' }] })
    await open(wrapper)
    expect(content()?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.disabled).toBe(true)

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(content()).toBeNull()
  })

  it('takes a custom trigger and a default slot, and follows a controlled open prop', async () => {
    const wrapper = mountMenu(
      { open: true, icon: 'clock', tone: 'info' },
      { trigger: '<button type="button" data-testid="custom">Two-way</button>', default: '<p data-testid="extra">More</p>' },
    )
    await flushPromises()
    expect(wrapper.find('[data-testid="sync-issue-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="custom"]').exists()).toBe(true)
    expect(content()?.querySelector('[data-testid="extra"]')).not.toBeNull()
  })

  it('names the trigger by the status and carries the id a switch describes itself by', () => {
    const named = mountMenu({ title: 'Needs review', triggerId: 'abs-status' })
    const trigger = named.get('[data-testid="sync-issue-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('Needs review')
    expect(trigger.attributes('id')).toBe('abs-status')
    const relabelled = mountMenu({ title: 'Pick the item', label: 'Needs review' })
    expect(relabelled.get('[data-testid="sync-issue-trigger"]').attributes('aria-label')).toBe('Needs review')
  })
})
