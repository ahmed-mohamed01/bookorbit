import type { CurrentlyReadingBook } from '@bookorbit/types'

export interface CurrentlyReadingStack {
  lead: CurrentlyReadingBook
  editions: CurrentlyReadingBook[]
}

function activityTime(book: CurrentlyReadingBook): number {
  const parsed = book.lastActivityAt ? Date.parse(book.lastActivityAt) : Number.NaN
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

function pickLead(members: readonly CurrentlyReadingBook[]): CurrentlyReadingBook {
  let lead = members[0]!
  for (const member of members.slice(1)) {
    if (activityTime(member) > activityTime(lead)) lead = member
  }
  return lead
}

export function stackCurrentlyReading(books: readonly CurrentlyReadingBook[]): CurrentlyReadingStack[] {
  const groups: CurrentlyReadingBook[][] = []
  const groupsById = new Map<number, CurrentlyReadingBook[]>()

  for (const book of books) {
    const groupId = book.editionGroupId
    if (groupId == null) {
      groups.push([book])
      continue
    }
    const existing = groupsById.get(groupId)
    if (existing) {
      existing.push(book)
    } else {
      const group = [book]
      groupsById.set(groupId, group)
      groups.push(group)
    }
  }

  return groups.map((members) => {
    const lead = pickLead(members)
    return { lead, editions: [lead, ...members.filter((member) => member !== lead)] }
  })
}

// A stack in a single cover's space, offset the way the grid's collapsed-series stack is: the lead sits in front
// at the bottom-right, and every edition behind it is a same-size card pushed up and to the left. The grid's 8%
// step is a blur at thumbnail size, so the steps here are larger; the sideways step spills a few pixels into
// the row's padding rather than shrinking the lead.
export const EDITION_STACK_MAX_VISIBLE = 3
const EDITION_STACK_PEEK_PCT = 12
const EDITION_STACK_SHIFT_PCT = 8

// A type alias, not an interface: Vue's style binding needs the implicit index signature only aliases carry.
export type EditionStackSlotStyle = {
  left: string
  width: string
  bottom: string
  height: string
  zIndex: number
}

export function editionStackLayout(count: number): EditionStackSlotStyle[] {
  const visible = Math.min(Math.max(count, 0), EDITION_STACK_MAX_VISIBLE)
  const height = 100 - EDITION_STACK_PEEK_PCT * Math.max(0, visible - 1)
  return Array.from({ length: visible }, (_, index) => ({
    left: `${-EDITION_STACK_SHIFT_PCT * index}%`,
    width: '100%',
    bottom: `${EDITION_STACK_PEEK_PCT * index}%`,
    height: `${height}%`,
    zIndex: EDITION_STACK_MAX_VISIBLE - index,
  }))
}

// Pins the stack's own top-left corner, which is the rearmost card's, so it moves out with the spill.
export function editionStackBadgeStyle(count: number): { left: string; top: string } {
  const visible = Math.min(Math.max(count, 1), EDITION_STACK_MAX_VISIBLE)
  return { left: `calc(${-EDITION_STACK_SHIFT_PCT * (visible - 1)}% + 1px)`, top: '1px' }
}
