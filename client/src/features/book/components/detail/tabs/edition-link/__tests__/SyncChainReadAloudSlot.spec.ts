import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ChainReadAloudSlotRow, SyncChainReadAloudJob, SyncChainReadAloudSlot as SlotInput } from '@/features/book/lib/sync-chain'
import SyncChainReadAloudSlot from '../SyncChainReadAloudSlot.vue'
import { chainOf, chainReadAloudJob, chainReadAloudSlot, readAloudSlotRow } from '@/features/book/lib/__tests__/sync-chain-fixtures'

function rowFor(slot: Partial<SlotInput>): ChainReadAloudSlotRow {
  return readAloudSlotRow(chainOf({ readAloudSlot: chainReadAloudSlot(slot) }))
}

function jobRow(job: Partial<SyncChainReadAloudJob> = {}): ChainReadAloudSlotRow {
  return rowFor({ job: chainReadAloudJob(job) })
}

function mountSlot(row: ChainReadAloudSlotRow, busy = false) {
  return mount(SyncChainReadAloudSlot, { props: { row, busy } })
}

function actionIds(wrapper: ReturnType<typeof mountSlot>): string[] {
  return wrapper.findAll('[data-testid="sync-chain-action"]').map((button) => button.attributes('data-action')!)
}

describe('SyncChainReadAloudSlot', () => {
  it('notCreated: Create read-aloud then Modify, each emitted with the slot id', async () => {
    const wrapper = mountSlot(rowFor({ entry: { kind: 'available' } }))

    expect(wrapper.get('[data-testid="sync-chain-read-aloud-slot"]').attributes('data-variant')).toBe('notCreated')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-label"]').text()).toBe('Read-aloud')
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('Not created yet')
    expect(actionIds(wrapper)).toEqual(['createReadAloud', 'modifyReadAloud'])
    expect(wrapper.get('[data-action="createReadAloud"]').text()).toBe('Create read-aloud')
    expect(wrapper.get('[data-action="modifyReadAloud"]').text()).toBe('Modify')

    await wrapper.get('[data-action="createReadAloud"]').trigger('click')
    await wrapper.get('[data-action="modifyReadAloud"]').trigger('click')
    expect(wrapper.emitted('action')).toEqual([
      ['createReadAloud', 'slot:readAlong'],
      ['modifyReadAloud', 'slot:readAlong'],
    ])
    expect(wrapper.find('[data-testid="read-aloud-stepper"]').exists()).toBe(false)
  })

  it('unavailable: upstream reason and no buttons', () => {
    const wrapper = mountSlot(
      rowFor({ entry: { kind: 'unavailable', reason: 'worker_unavailable', reasonKey: 'book.detail.files.readAloud.reasons.worker_unavailable' } }),
    )
    expect(actionIds(wrapper)).toEqual([])
    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).not.toBe('')
  })

  it('queued: a cancel X and a stepper with no percent', async () => {
    const wrapper = mountSlot(jobRow({ status: 'queued', stage: 'queued', queuePosition: 0 }))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('Next in line')
    expect(actionIds(wrapper)).toEqual(['cancelReadAloud'])
    expect(wrapper.get('[data-action="cancelReadAloud"]').attributes('aria-label')).toBe('Cancel generation')
    expect(wrapper.find('[data-testid="read-aloud-stepper"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="read-aloud-percent"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-stage-state="todo"]')).toHaveLength(6)

    await wrapper.get('[data-action="cancelReadAloud"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['cancelReadAloud', 'slot:readAlong'])
  })

  it('processing: stage label, upstream steps up to the current one, and the percent', () => {
    const wrapper = mountSlot(jobRow())

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('Matching the text to the narration')
    expect(wrapper.get('[data-testid="read-aloud-percent"]').text()).toBe('42%')
    const states = wrapper.findAll('[data-testid="read-aloud-stage"]').map((step) => [step.text(), step.attributes('data-stage-state')])
    expect(states).toEqual([
      ['Audio', 'done'],
      ['Speech', 'done'],
      ['Text', 'done'],
      ['Align', 'current'],
      ['Check', 'todo'],
      ['Publish', 'todo'],
    ])
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
  })

  it('review: Review only', async () => {
    const wrapper = mountSlot(jobRow({ status: 'awaiting_review', stage: 'awaiting_review' }))

    expect(wrapper.get('[data-testid="sync-chain-placeholder-note"]').text()).toBe('Ready for review')
    expect(actionIds(wrapper)).toEqual(['reviewReadAloud'])
    expect(wrapper.find('[data-testid="read-aloud-stepper"]').exists()).toBe(false)
    await wrapper.get('[data-action="reviewReadAloud"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['reviewReadAloud', 'slot:readAlong'])
  })

  it('failed: Retry and Review', () => {
    const wrapper = mountSlot(jobRow({ status: 'failed', errorKey: 'book.detail.files.readAloud.errors.job.alignment_failed' }))

    expect(actionIds(wrapper)).toEqual(['retryReadAloud', 'reviewReadAloud'])
    expect(wrapper.get('[data-action="retryReadAloud"]').text()).toBe('Retry')
    expect(wrapper.find('[data-testid="read-aloud-stepper"]').exists()).toBe(false)
  })

  it('spins the action in flight and disables everything while the panel is busy', () => {
    const starting = mountSlot(rowFor({ entry: { kind: 'available' }, pending: 'create' }))
    expect(starting.get('[data-action="createReadAloud"]').attributes('aria-busy')).toBe('true')
    expect(starting.get('[data-action="createReadAloud"]').attributes('disabled')).toBeDefined()

    const busy = mountSlot(rowFor({ entry: { kind: 'available' } }), true)
    for (const button of busy.findAll('[data-testid="sync-chain-action"]')) expect(button.attributes('disabled')).toBeDefined()
  })
})
