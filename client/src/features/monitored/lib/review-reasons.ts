import { isWorkUnconfirmed, type MonitoredWork } from '@bookorbit/types'

type Translate = (key: string) => string
type HasKey = (key: string) => boolean

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function humanizeKey(raw: string): string {
  return capitalize(raw.replace(/_/g, ' '))
}

function labelFor(key: string, raw: string, t: Translate, te: HasKey): string {
  return te(key) ? capitalize(t(key)) : humanizeKey(raw)
}

/** Why an unconfirmed work sits in the queue: the verdict first, then one label per flag. */
export function reviewReasons(work: MonitoredWork, t: Translate, te: HasKey): string[] {
  if (!isWorkUnconfirmed(work)) return []
  const reasons: string[] = []
  if (work.verdict !== 'verified') reasons.push(labelFor(`monitored.panel.banner.verdict.${work.verdict}`, work.verdict, t, te))
  for (const flag of work.flags) reasons.push(labelFor(`monitored.panel.flags.${flag}`, flag, t, te))
  return reasons
}

export function kindPillLabel(kind: string, t: Translate, te: HasKey): string {
  return labelFor(`monitored.review.badges.${kind}`, kind, t, te)
}
