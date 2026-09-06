import { describe, it, expect, vi } from 'vitest'
import { resumeCrossFormat } from '../crossFormatResumeNav'

function asyncGen<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item
  })()
}

// Whole-book search yields one object per matching section: { subitems: [{ cfi }] }.
function sectionHit(cfi: string) {
  return { label: '', subitems: [{ cfi, excerpt: {} }] }
}

function makeView(overrides: Record<string, unknown> = {}) {
  return {
    goTo: vi.fn<(target: string | number) => Promise<{ index: number } | undefined>>().mockResolvedValue({ index: 3 }),
    goToFraction: vi.fn<(f: number) => Promise<void>>().mockResolvedValue(undefined),
    getSectionFractions: vi.fn<() => number[]>().mockReturnValue([0, 0.1, 0.2, 0.3, 0.4]),
    search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen<unknown>([])),
    clearSearch: vi.fn<() => void>(),
    ...overrides,
  }
}

// spineIndex 2 -> CFI spine step 2*(2+1) = 6, i.e. a CFI beginning "epubcfi(/6/6...".
const resume = { phrase: 'hello there', spineIndex: 2, percentage: 40 }

describe('resumeCrossFormat ladder', () => {
  it('navigates to the exact phrase CFI in the target section (precise)', async () => {
    const view = makeView({ search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([sectionHit('epubcfi(/6/6!/4/2)')])) })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.search).toHaveBeenCalledWith({ query: 'hello there' })
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/6!/4/2)')
    expect(view.clearSearch).toHaveBeenCalled()
    expect(view.goToFraction).not.toHaveBeenCalled()
  })

  it('prefers the hit in the target section over an earlier hit elsewhere', async () => {
    const view = makeView({
      search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([sectionHit('epubcfi(/6/4!/2)'), sectionHit('epubcfi(/6/6!/8)')])),
    })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/6!/8)') // spine step 6 == target
  })

  it('uses the first hit when no hit is in the target section', async () => {
    const view = makeView({ search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([sectionHit('epubcfi(/6/4!/2)')])) })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/4!/2)')
  })

  it('falls back to the section start when the phrase is not found (right chapter)', async () => {
    const view = makeView({ search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen(['done'])) })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.goTo).not.toHaveBeenCalled()
    expect(view.goToFraction).toHaveBeenCalledWith(0.2) // getSectionFractions()[spineIndex=2]
  })

  it('falls back to the whole-book fraction when no section fraction is available (coarse)', async () => {
    const view = makeView({
      search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([])),
      getSectionFractions: vi.fn<() => number[]>().mockReturnValue([]),
    })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.goToFraction).toHaveBeenCalledWith(0.4) // percentage/100
  })

  it('falls back to the section start when goTo(cfi) does not resolve', async () => {
    const view = makeView({
      search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([sectionHit('epubcfi(/6/6!/bad)')])),
      goTo: vi.fn<(target: string | number) => Promise<{ index: number } | undefined>>().mockResolvedValue(undefined),
    })

    const ok = await resumeCrossFormat(view, resume)

    expect(ok).toBe(true)
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/6!/bad)')
    expect(view.goToFraction).toHaveBeenCalledWith(0.2)
  })

  it('returns false when nothing can navigate', async () => {
    const view = makeView({
      search: vi.fn<() => AsyncIterable<unknown>>(() => asyncGen([])),
      getSectionFractions: vi.fn<() => number[]>().mockReturnValue([]),
    })

    const ok = await resumeCrossFormat(view, { phrase: 'x', spineIndex: 0, percentage: 0 })

    expect(ok).toBe(false)
    expect(view.goToFraction).not.toHaveBeenCalled()
  })
})
