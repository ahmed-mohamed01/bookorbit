import type { StoryGuideAction, StoryGuidePresentation } from '@/features/story-guide/lib/story-guide-presentation'

const JOB_ACTIONS: ReadonlySet<StoryGuideAction> = new Set(['retry', 'keepBuilding', 'resume', 'cancelBuild', 'dismiss'])

/** The job's controls: the card's row buttons plus the job actions its menu offered beside them. */
export function storyGuideJobActions({ rows, menu }: StoryGuidePresentation): StoryGuideAction[] {
  const row = rows[0]
  const shown = row?.kind === 'notice' ? row.actions : []
  return [...new Set([...shown, ...menu.filter((action) => JOB_ACTIONS.has(action))])]
}

/** The guide's own actions for the tab's menu; job controls sit on the job's bar instead. */
export function storyGuideMenuActions({ menu }: StoryGuidePresentation): StoryGuideAction[] {
  return menu.filter((action) => !JOB_ACTIONS.has(action))
}
