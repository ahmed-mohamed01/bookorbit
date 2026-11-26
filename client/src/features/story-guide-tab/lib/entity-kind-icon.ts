import type { Component } from 'vue'
import { CalendarDays, Gem, Lightbulb, MapPin, Tag, User, Users } from '@lucide/vue'
import type { StoryGuideEntityKind } from '@bookorbit/types'
import { entityGroup } from './story-guide-view'

const ICONS: Record<StoryGuideEntityKind, Component> = {
  character: User,
  place: MapPin,
  group: Users,
  event: CalendarDays,
  object: Gem,
  idea: Lightbulb,
}

const COLORS = { people: 'text-star-highlight', places: 'text-info', terms: 'text-muted-foreground' } as const

export function entityKindIcon(kind: string): Component {
  return Object.hasOwn(ICONS, kind) ? ICONS[kind as StoryGuideEntityKind] : Tag
}

/** The kind's colour, shared by the constellation stars and the kind icons. */
export function entityKindColor(kind: string): string {
  return COLORS[entityGroup(kind)]
}
