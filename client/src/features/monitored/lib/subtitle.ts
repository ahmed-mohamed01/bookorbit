import type { MonitoredSeriesMembership } from '@bookorbit/types'
import { normalizeSeriesName } from './grouping'

const POSITION_WORDS = /\b(?:book|volume|vol|part|no|number|series)\b/g
const NUMBERS = /\b\d+(?:\.\d+)?\b/g

function stripPosition(text: string): string {
  return normalizeSeriesName(text).replace(POSITION_WORDS, ' ').replace(NUMBERS, ' ').replace(/\s+/g, ' ').trim()
}

/** A metadata subtitle such as "The Strata Wars, Book 1" only restates the series row beneath the title. */
export function subtitleRepeatsSeries(subtitle: string | null | undefined, memberships: readonly MonitoredSeriesMembership[]): boolean {
  if (!subtitle?.trim()) return false
  const rest = stripPosition(subtitle)
  if (!rest) return false
  return memberships.some((membership) => stripPosition(membership.name) === rest)
}
