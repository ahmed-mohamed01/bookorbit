import type { StoryGuidePhase } from '@/features/story-guide/lib/story-guide-presentation'

export type StoryGuideTabStepState = 'done' | 'now' | 'pending'
export interface StoryGuideTabStep {
  kind: StoryGuidePhase['kind']
  phase: StoryGuidePhase
  state: StoryGuideTabStepState
}

/** The steps a Book Knowledge build passes through, in order. */
export const STORY_GUIDE_TAB_STEPS = ['reading', 'findingNames', 'checkingWho', 'writing', 'finishing'] as const

const WRITING = STORY_GUIDE_TAB_STEPS.indexOf('writing')
const LAST = STORY_GUIDE_TAB_STEPS.length - 1

function currentStep(phase: StoryGuidePhase, fraction: number | null): number {
  // `building` is the unit's own start (nothing reported yet) or its end, which a cached build reaches at once.
  if (phase.kind === 'building') return fraction !== null && fraction >= 1 ? LAST : 0
  const index = (STORY_GUIDE_TAB_STEPS as readonly string[]).indexOf(phase.kind)
  return index === -1 ? WRITING : index
}

export function storyGuideTabSteps(phase: StoryGuidePhase, fraction: number | null): StoryGuideTabStep[] {
  const current = currentStep(phase, fraction)
  return STORY_GUIDE_TAB_STEPS.map((kind, index) => ({
    kind,
    phase: index === current && phase.kind === kind ? phase : kind === 'writing' ? { kind, chapter: null, total: null } : { kind },
    state: index < current ? 'done' : index === current ? 'now' : 'pending',
  }))
}
