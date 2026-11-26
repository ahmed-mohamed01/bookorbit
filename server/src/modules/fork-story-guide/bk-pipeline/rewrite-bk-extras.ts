import type { BookKnowledgeXrayPayload, StoryGuideAnchor, StoryGuideLine, StoryGuidePayloadV1 } from '@bookorbit/types';

import type { StoryGuidesService } from '../../story-guides/story-guides.service';

function anchorKey(anchor: StoryGuideAnchor): string {
  return `${anchor.s}:${'end' in anchor ? 'end' : anchor.o}`;
}

export function rewriteBkExtras<T>(payload: T): T {
  const guide = payload as T & StoryGuidePayloadV1 & Partial<Pick<BookKnowledgeXrayPayload, 'chronicle' | 'links'>>;
  if (!guide?.chronicle) return payload;
  const { chronicle, links } = guide;

  const entriesByKey = new Map<string, { entityKey: string; profiles: StoryGuideLine[] | undefined }>();
  for (const entity of guide.entities) {
    entriesByKey.set(entity.key, { entityKey: entity.key, profiles: entity.profiles });
    for (const join of entity.joins) entriesByKey.set(join.key, { entityKey: entity.key, profiles: join.profiles });
  }

  const entities = Object.fromEntries(
    Object.entries(chronicle.entities).flatMap(([key, entity]) => {
      const entry = entriesByKey.get(key);
      if (!entry) return [];
      const { profiles } = entry;
      if (!Array.isArray(profiles)) return [[key, entity]] as const;

      const anchors = new Map(entity.about.map(({ through }) => [anchorKey(through), through]));
      const about = profiles.map(({ through, text }) => ({ through: anchors.get(anchorKey(through)) ?? through, text }));
      return [[key, { ...entity, about }]] as const;
    }),
  );

  function connectsDistinctEntities(a: string, b: string): boolean {
    const entityA = entriesByKey.get(a)?.entityKey;
    const entityB = entriesByKey.get(b)?.entityKey;
    return entityA !== undefined && entityB !== undefined && entityA !== entityB;
  }

  const pairs =
    chronicle.pairs &&
    Object.fromEntries(
      Object.entries(chronicle.pairs).filter(([key]) => {
        const [a, b] = key.split('|');
        return connectsDistinctEntities(a, b);
      }),
    );

  const joins =
    chronicle.joins &&
    Object.fromEntries(
      Object.entries(chronicle.joins).filter(([key]) => {
        const entry = entriesByKey.get(key);
        return entry !== undefined && entry.entityKey !== key;
      }),
    );

  return {
    ...guide,
    chronicle: { ...chronicle, entities, ...(pairs && { pairs }), ...(joins && { joins }) },
    ...(links && { links: links.filter(({ a, b }) => connectsDistinctEntities(a, b)) }),
  };
}

/**
 * Upstream's guide content for the fork readers, with the BK extras brought in line with reader fixes. The
 * ETag comes from the stored hash and the fixes revision, so rewriting after `content` keeps it valid.
 */
export async function bkGuideContent(
  guides: Pick<StoryGuidesService, 'content'>,
  ...args: Parameters<StoryGuidesService['content']>
): ReturnType<StoryGuidesService['content']> {
  const content = await guides.content(...args);
  return content.kind === 'found' ? { ...content, body: rewriteBkExtras(content.body) } : content;
}
