import type { CrossFormatEbookResume } from '../../shared/composables/useCrossFormatResume'

// The minimal slice of the foliate view the resume ladder drives.
export interface FoliateNavView {
  goTo: (target: string | number) => Promise<unknown>
  goToFraction?: (f: number) => void | Promise<void>
  getSectionFractions?: () => number[]
  search?: (opts: { query: string; index?: number }) => AsyncIterable<unknown>
  clearSearch?: () => void
}

// A navigation "resolved" to a real spine location (foliate returns an object with a numeric index).
function isResolvedNavigation(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && typeof (value as { index?: unknown }).index === 'number')
}

// A foliate spine CFI starts with `/6/N`, where N = 2*(spineIndex+1). Lets us tell which section a
// search hit is in without the search API exposing a section index.
function cfiSpineStep(cfi: string): number | null {
  const match = /^epubcfi\(\/6\/(\d+)/.exec(cfi)
  return match ? Number(match[1]) : null
}

// Finds the exact CFI of `phrase` via a whole-book search (the same path the search panel uses;
// section-scoped search is unreliable with the streaming EPUB loader), then clears the transient
// search highlight. Prefers a hit in the anchor's own section (matched by CFI spine step) and falls
// back to the first hit anywhere. Returns null when the phrase cannot be located (e.g. normalization
// differences) so the caller can fall back to a coarser position.
export async function searchPhraseCfi(view: FoliateNavView, phrase: string, spineIndex: number): Promise<string | null> {
  if (typeof view.search !== 'function') return null
  const targetStep = (spineIndex + 1) * 2
  let firstCfi: string | null = null
  try {
    for await (const result of view.search({ query: phrase })) {
      const subitems = (result as { subitems?: Array<{ cfi?: unknown }> })?.subitems
      if (!Array.isArray(subitems)) continue
      for (const item of subitems) {
        const cfi = item?.cfi
        if (typeof cfi !== 'string' || !cfi) continue
        if (firstCfi === null) firstCfi = cfi
        if (cfiSpineStep(cfi) === targetStep) {
          view.clearSearch?.()
          return cfi
        }
      }
    }
  } catch {
    // search failed or the view was torn down - fall through to a coarser resume
  }
  view.clearSearch?.()
  return firstCfi
}

// Resume ladder for opening the ebook when the audiobook is ahead:
//   1. exact phrase search within the anchor's section (paragraph precision)
//   2. start of the correct section (right chapter) - avoids the byte-vs-char fraction drift
//   3. whole-book fraction from the percentage (last resort)
// Returns true once any step navigates.
export async function resumeCrossFormat(view: FoliateNavView, resume: CrossFormatEbookResume): Promise<boolean> {
  const cfi = await searchPhraseCfi(view, resume.phrase, resume.spineIndex)
  if (cfi) {
    const navigated = await view
      .goTo(cfi)
      .then((r) => isResolvedNavigation(r))
      .catch(() => false)
    if (navigated) return true
  }

  if (typeof view.goToFraction === 'function') {
    const sectionFraction = view.getSectionFractions?.()?.[resume.spineIndex]
    if (typeof sectionFraction === 'number' && Number.isFinite(sectionFraction) && sectionFraction >= 0) {
      try {
        await view.goToFraction(sectionFraction)
        return true
      } catch {
        // fall through to the whole-book fraction
      }
    }

    if (resume.percentage > 0) {
      try {
        await view.goToFraction(resume.percentage / 100)
        return true
      } catch {
        // give up; the caller lands at the start of the book
      }
    }
  }

  return false
}
