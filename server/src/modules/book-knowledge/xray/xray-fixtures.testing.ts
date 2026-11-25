import type { StoryGuideEntityKind } from '@bookorbit/types';
import type { XrayEntity } from './xray-entities';

export function entity(id: string, kind: StoryGuideEntityKind, ordinals: number[], extra: Partial<XrayEntity> = {}): XrayEntity {
  return {
    id,
    key: id,
    name: id.toUpperCase(),
    kind,
    sub: null,
    importance: 1,
    rank: 0,
    count: ordinals.length,
    first: ordinals[0] ?? 1,
    ordinals,
    defining: new Set(),
    names: [{ text: id.toUpperCase(), ordinal: ordinals[0] ?? 1 }],
    joins: [],
    ...extra,
  };
}
