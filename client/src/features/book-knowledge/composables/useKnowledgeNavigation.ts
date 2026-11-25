import { onScopeDispose } from 'vue'
import type { BookKnowledgePassage } from '@bookorbit/types'

export interface KnowledgeReaderView {
  search(options: { query: string; index: number }): AsyncIterable<{ cfi?: string } | string>
  clearSearch(): void
}
export function useKnowledgeNavigation(getView: () => KnowledgeReaderView | null, canNavigate: () => boolean, navigate: (target: string) => unknown) {
  let generation = 0
  function cancel() {
    generation++
  }
  onScopeDispose(cancel)
  async function jump(passage: BookKnowledgePassage): Promise<boolean> {
    if (!canNavigate()) return false
    const current = ++generation
    const view = getView()
    let target = passage.href
    if (view) {
      try {
        for await (const result of view.search({
          query: passage.text.match(/^.*?[.!?]+[”"’']*(?=\s|$)/s)?.[0] ?? passage.text,
          index: passage.spineIndex,
        })) {
          if (current !== generation) return false
          if (typeof result === 'object' && result.cfi) {
            target = result.cfi
            break
          }
        }
      } catch {
        // Text normalization can prevent a passage from matching the EPUB exactly.
      }
    }
    if (current !== generation || !canNavigate()) return false
    try {
      await navigate(target)
      view?.clearSearch()
      return current === generation
    } catch {
      return false
    }
  }
  return { jump, cancel }
}
