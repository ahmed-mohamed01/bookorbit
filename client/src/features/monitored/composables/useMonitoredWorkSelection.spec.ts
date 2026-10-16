import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useMonitoredWorkSelection } from './useMonitoredWorkSelection'

const click = (shiftKey = false) => ({ shiftKey }) as MouseEvent

function setup(ids: string[] = ['a', 'b', 'c', 'd', 'e']) {
  const orderedIds = ref(ids)
  return { orderedIds, selection: useMonitoredWorkSelection(orderedIds) }
}

describe('useMonitoredWorkSelection', () => {
  it('toggles one id per plain click', () => {
    const { selection } = setup()

    selection.handleSelect('b', click())
    expect([...selection.selectedIds.value]).toEqual(['b'])

    selection.handleSelect('b', click())
    expect(selection.selectedIds.value.size).toBe(0)
  })

  it('selects a range in on-screen order on shift-click', () => {
    const { selection } = setup(['e', 'd', 'c', 'b', 'a'])

    selection.handleSelect('d', click())
    selection.handleSelect('b', click(true))

    expect([...selection.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])
  })

  it('adds and removes many ids at once', () => {
    const { selection } = setup()

    selection.selectMany(['a', 'b', 'c'])
    selection.deselectMany(['b'])

    expect([...selection.selectedIds.value].sort()).toEqual(['a', 'c'])
  })

  it('drops selected ids that leave the screen', async () => {
    const { orderedIds, selection } = setup()
    selection.selectMany(['a', 'b'])

    orderedIds.value = ['b', 'c']
    await nextTick()

    expect([...selection.selectedIds.value]).toEqual(['b'])
  })

  it('keeps ids the page still holds even when they are outside the range order', async () => {
    const orderedIds = ref(['a'])
    const presentIds = ref(['a', 'b'])
    const selection = useMonitoredWorkSelection(orderedIds, { presentIds })
    selection.selectMany(['a', 'b'])

    orderedIds.value = []
    await nextTick()

    expect([...selection.selectedIds.value].sort()).toEqual(['a', 'b'])
  })

  it('clears the selection when select mode is left', () => {
    const { selection } = setup()
    selection.toggleSelectionMode()
    selection.selectMany(['a'])

    selection.toggleSelectionMode()

    expect(selection.selectionMode.value).toBe(false)
    expect(selection.selectedIds.value.size).toBe(0)
  })
})
