import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { BookKnowledgePassage } from '@bookorbit/types'
import { useKnowledgeNavigation, type KnowledgeReaderView } from './useKnowledgeNavigation'
const passage: BookKnowledgePassage = {
  number: 1,
  text: 'The violet arch rang softly.',
  ordinals: [3],
  spineIndex: 2,
  paragraphIndex: 0,
  href: 'arch.xhtml',
}
function setup(view: KnowledgeReaderView, allowed = true) {
  const scope = effectScope()
  const navigate = vi.fn<(target: string) => void>()
  const navigation = scope.run(() =>
    useKnowledgeNavigation(
      () => view,
      () => allowed,
      navigate,
    ),
  )!
  return { scope, navigate, ...navigation }
}
describe('knowledge passage navigation', () => {
  it('uses chapter-scoped text search and the existing CFI navigation path', async () => {
    const view = {
      search: vi.fn<KnowledgeReaderView['search']>(async function* () {
        yield { cfi: 'invented-cfi' }
      }),
      clearSearch: vi.fn<() => void>(),
    }
    const nav = setup(view)
    expect(await nav.jump(passage)).toBe(true)
    expect(view.search).toHaveBeenCalledWith({ query: passage.text, index: 2 })
    expect(nav.navigate).toHaveBeenCalledWith('invented-cfi')
    expect(view.clearSearch).toHaveBeenCalledOnce()
    nav.scope.stop()
  })
  it('falls back to href when normalized text has no exact match', async () => {
    const nav = setup({
      search: async function* () {
        yield 'done'
      },
      clearSearch: vi.fn<() => void>(),
    })
    await nav.jump(passage)
    expect(nav.navigate).toHaveBeenCalledWith('arch.xhtml')
    nav.scope.stop()
  })
  it('does not navigate while locked', async () => {
    const nav = setup(
      {
        search: async function* () {
          yield 'done'
        },
        clearSearch: vi.fn<() => void>(),
      },
      false,
    )
    expect(await nav.jump(passage)).toBe(false)
    expect(nav.navigate).not.toHaveBeenCalled()
    nav.scope.stop()
  })
  it('cancels an unfinished jump when its scope is disposed', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const nav = setup({
      search: async function* () {
        await waiting
        yield { cfi: 'old-cfi' }
      },
      clearSearch: vi.fn<() => void>(),
    })
    const jump = nav.jump(passage)
    nav.scope.stop()
    finish()
    expect(await jump).toBe(false)
    expect(nav.navigate).not.toHaveBeenCalled()
  })
})

it('searches only the first complete sentence instead of the whole passage', async () => {
  const view = {
    search: vi.fn<KnowledgeReaderView['search']>(async function* () {
      yield { cfi: 'first-sentence' }
    }),
    clearSearch: vi.fn<() => void>(),
  }
  const nav = setup(view)
  await nav.jump({ ...passage, text: 'Violet Arch: The violet arch rang softly. Its keeper waited. Another bell answered.' })
  expect(view.search).toHaveBeenCalledWith({ query: 'Violet Arch: The violet arch rang softly.', index: 2 })
  nav.scope.stop()
})
