import { describe, expect, it } from 'vitest'
import { CalendarDays, Gem, Lightbulb, MapPin, Tag, User, Users } from '@lucide/vue'
import { STORY_GUIDE_ENTITY_KINDS } from '@bookorbit/types'
import { entityKindColor, entityKindIcon } from './entity-kind-icon'

describe('entityKindIcon', () => {
  it('gives every entity kind its icon and an unknown kind the tag', () => {
    expect(STORY_GUIDE_ENTITY_KINDS.map(entityKindIcon)).toEqual([User, MapPin, Users, CalendarDays, Gem, Lightbulb])
    expect(entityKindIcon('term')).toBe(Tag)
    expect(entityKindIcon('toString')).toBe(Tag)
  })

  it('keeps the kind colours of people, places and the rest', () => {
    expect(entityKindColor('character')).toBe('text-star-highlight')
    expect(entityKindColor('place')).toBe('text-info')
    expect(entityKindColor('idea')).toBe('text-muted-foreground')
  })
})
