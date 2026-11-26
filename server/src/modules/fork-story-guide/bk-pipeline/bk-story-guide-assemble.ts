import type {
  AiJobModels,
  BookKnowledgeXrayEntity,
  BookKnowledgeXrayLink,
  BookKnowledgeXrayPayload,
  StoryGuideChronicle,
  StoryGuideJoin,
  StoryGuideLine,
  StoryGuidePayloadV1,
} from '@bookorbit/types';

export interface BkExtras {
  links: BookKnowledgeXrayLink[];
  chronicle?: StoryGuideChronicle;
}

export interface BkStoryGuideMeta {
  textKey: string;
  pipeline: string;
  models: AiJobModels;
  coverage: number;
  builtAt: string;
}

export type BkStoryGuidePayload = StoryGuidePayloadV1 & BkExtras;

function aboutProfiles(chronicle: StoryGuideChronicle | undefined, key: string): StoryGuideLine[] | undefined {
  const about = chronicle?.entities[key]?.about;
  return about ? about.map(({ text, through }) => ({ text, through })) : undefined;
}

function withProfiles<T extends { key: string; profiles?: StoryGuideLine[] }>(item: T, chronicle: StoryGuideChronicle | undefined): T {
  const profiles = aboutProfiles(chronicle, item.key);
  return profiles ? { ...item, profiles } : item;
}

export function assembleBkStoryGuide(
  bk: Omit<BookKnowledgeXrayPayload, 'coverage'> & { coverage?: number },
  meta: BkStoryGuideMeta,
): BkStoryGuidePayload {
  const models: StoryGuidePayloadV1['models'] = {};
  if (meta.models.fast) models.fast = meta.models.fast.model;
  if (meta.models.careful) models.careful = meta.models.careful.model;

  const entities: BookKnowledgeXrayEntity[] = bk.entities.map((entity) => ({
    ...withProfiles(entity, bk.chronicle),
    joins: entity.joins.map((join): StoryGuideJoin => withProfiles(join, bk.chronicle)),
  }));

  const coverage = bk.coverage !== undefined && Number.isFinite(bk.coverage) ? Math.min(meta.coverage, bk.coverage) : meta.coverage;
  return {
    ...bk,
    format: 1,
    textKey: meta.textKey,
    pipeline: meta.pipeline,
    builtAt: meta.builtAt,
    models,
    coverage: Math.max(0, Math.min(1, coverage)),
    entities,
    ...(bk.chronicle ? { chronicle: { ...bk.chronicle, basis: meta.builtAt } } : {}),
  };
}
