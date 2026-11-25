import {
  type BookKnowledgeXrayAnchor,
  type BookKnowledgeXrayEntity,
  type BookKnowledgeXrayLink,
  type BookKnowledgeXrayPayload,
  type StoryGuideChronicle,
  type StoryGuideChronicleEntity,
  type StoryGuideChronicleVersioned,
  type StoryGuideLine,
  type StoryGuideSectionInfo,
  type StoryGuideTie,
} from '@bookorbit/types';
import type { CheckedFact, CheckedLine, CheckedTie } from './xray-checks';
import { anyTieType } from './xray-tie-types';
import type { XrayEntity, XrayName } from './xray-entities';
import type { XrayLinkSnapshot } from './xray-links';

export const XRAY_PIPELINE = 'bk-xray-1';
const TIE_QUOTES = 3;

export interface XraySummary {
  text: string;
  /** The last sentence the summary was written from. */
  ordinal: number;
}

export interface XrayBuildResult {
  fingerprint: string;
  builtAt: string;
  language: string;
  models: Partial<Record<'fast' | 'careful', string>>;
  coverage: number;
  sections: StoryGuideSectionInfo[];
  entities: readonly XrayEntity[];
  ties: readonly CheckedTie[];
  lines: readonly CheckedLine[];
  facts: readonly CheckedFact[];
  summaries: readonly XraySummary[];
  links: readonly XrayLinkSnapshot[];
  /** The one-pass build's chronicle, keyed by entity (and join) until keys are given out here. */
  chronicle?: ChronicleDraft;
  /** Where a partial build's chronicle stops. */
  covers?: BookKnowledgeXrayAnchor;
}

/** An entity, or one of its joins by the member's term key, before payload keys exist. */
export interface ChronicleRef {
  entity: XrayEntity;
  join: string | null;
}

export interface ChronicleDraft {
  entities: { ref: ChronicleRef; value: StoryGuideChronicleEntity }[];
  pairs: { a: ChronicleRef; b: ChronicleRef; versions: StoryGuideChronicleVersioned[] }[];
}

/** Upstream's entity key: the folded name, spaces to hyphens, `-2`, `-3` for collisions in reading order. */
export function foldKey(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'entry'
  );
}

class Keys {
  private readonly used = new Set<string>();
  take(name: string): string {
    const base = foldKey(name);
    let key = base;
    for (let n = 2; this.used.has(key); n++) key = `${base}-${n}`;
    this.used.add(key);
    return key;
  }
}

/**
 * Book Knowledge output as upstream's `StoryGuidePayloadV1`, plus the fork-only `links`. Every item's
 * `at` (or `through`) comes from the sentence it cites, so one spoiler check serves every arm.
 */
export function xrayPayload(build: XrayBuildResult, anchor: (ordinal: number) => BookKnowledgeXrayAnchor): BookKnowledgeXrayPayload {
  // With a chronicle, an entry with no line, no note and no tie is a bare name ("Toil", "Paddle"), nothing a reader can open.
  const speaks = new Set<XrayEntity>([...build.lines.map((line) => line.entity), ...build.ties.flatMap((tie) => [tie.a, tie.b])]);
  for (const { ref, value } of build.chronicle?.entities ?? [])
    if (ref.join === null && (value.about.length > 0 || value.timeline.some((entry) => entry.note))) speaks.add(ref.entity);
  const shown = build.chronicle ? build.entities.filter((entity) => speaks.has(entity)) : build.entities;
  const keys = new Keys();
  const keyOf = new Map<XrayEntity, string>();
  for (const entity of [...shown].sort((a, b) => a.first - b.first)) keyOf.set(entity, keys.take(entity.name));
  const names = (list: readonly XrayName[]) => list.map((name) => ({ text: name.text, at: anchor(name.ordinal) }));
  const line = (ordinal: number, text: string): StoryGuideLine => ({ through: anchor(ordinal), text });

  const cited = (items: readonly { entity: XrayEntity; ordinal: number; text: string }[]) => {
    const byEntity = new Map<XrayEntity, StoryGuideLine[]>();
    for (const item of [...items].sort((x, y) => x.ordinal - y.ordinal))
      byEntity.set(item.entity, [...(byEntity.get(item.entity) ?? []), line(item.ordinal, item.text)]);
    return byEntity;
  };
  const linesOf = cited(build.lines.map((checked) => ({ entity: checked.entity, ordinal: checked.through, text: checked.text })));

  const joinKeys = new Map<string, string>();
  const entities: BookKnowledgeXrayEntity[] = shown.map((entity) => ({
    key: keyOf.get(entity)!,
    name: entity.name,
    kind: entity.kind,
    ...(entity.sub ? { sub: entity.sub } : {}),
    importance: entity.importance,
    count: entity.count,
    names: names(entity.names),
    joins: entity.joins.map((join) => ({
      key: joinKey(entity, join.key, keys.take(join.name)),
      name: join.name,
      names: names(join.names),
      lines: [],
      profiles: [],
      at: anchor(join.ordinal),
    })),
    lines: linesOf.get(entity) ?? [],
    // Facts are single clauses; a story guide viewer shows an entry's newest profile as its whole description.
    profiles: [],
    fixed: false,
  }));

  const ties = new Map<string, { a: string; type: string; b: string; cites: Set<number> }>();
  for (const tie of build.ties) {
    const a = keyOf.get(tie.a)!;
    const b = keyOf.get(tie.b)!;
    const key = `${a}|${tie.type}|${b}`;
    const existing = ties.get(key);
    if (existing) existing.cites.add(tie.cite);
    else ties.set(key, { a, type: tie.type, b, cites: new Set([tie.cite]) });
  }
  const payloadTies: StoryGuideTie[] = [...ties].map(([key, tie]) => {
    const cites = [...tie.cites].sort((x, y) => x - y);
    return {
      key,
      a: tie.a,
      type: tie.type,
      b: tie.b,
      label: anyTieType(tie.type)?.label ?? tie.type,
      at: anchor(cites[0]),
      quotes: cites.slice(0, TIE_QUOTES).map(anchor),
      count: cites.length,
      fixed: false,
    };
  });

  function joinKey(entity: XrayEntity, member: string, key: string): string {
    joinKeys.set(`${entity.key}\u0000${member}`, key);
    return key;
  }
  const refKey = (ref: ChronicleRef) => (ref.join === null ? keyOf.get(ref.entity) : joinKeys.get(`${ref.entity.key}\u0000${ref.join}`));
  let chronicle: StoryGuideChronicle | undefined;
  if (build.chronicle) {
    chronicle = { version: 1, basis: build.builtAt, ...(build.covers ? { covers: build.covers } : {}), entities: {}, pairs: {} };
    for (const { ref, value } of build.chronicle.entities) {
      const key = refKey(ref);
      if (key) chronicle.entities[key] = value;
    }
    for (const pair of build.chronicle.pairs) {
      const sides = [refKey(pair.a), refKey(pair.b)];
      if (sides[0] && sides[1] && sides[0] !== sides[1]) chronicle.pairs![sides.sort().join('|')] = pair.versions;
    }
  }

  const byTerm = new Map(shown.map((entity) => [entity.key, keyOf.get(entity)!]));
  // A snapshot ranks the cast as of its checkpoint; a pair outside the build's own cast has no entry to point at.
  const links: BookKnowledgeXrayLink[] = build.links.flatMap((link) => {
    const a = byTerm.get(link.a);
    const b = byTerm.get(link.b);
    if (!a || !b) return [];
    return [
      {
        a,
        b,
        score: Math.round(link.score * 1000) / 1000,
        count: link.count,
        at: anchor(link.from),
        ...(link.until === null ? {} : { until: anchor(link.until) }),
      },
    ];
  });

  return {
    format: 1,
    textKey: `bk:${build.fingerprint}`,
    pipeline: XRAY_PIPELINE,
    builtAt: build.builtAt,
    language: build.language,
    models: build.models,
    coverage: build.coverage,
    fixesRevision: 0,
    sections: build.sections,
    entities,
    ties: payloadTies,
    summaries: build.summaries.map((summary) => line(summary.ordinal, summary.text)),
    links,
    ...(chronicle ? { chronicle } : {}),
  };
}
