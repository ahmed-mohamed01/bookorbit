import type { BookKnowledgeXrayAnchor, BookKnowledgeXrayMode, StoryGuideChronicleEntity } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import type { CheckedFact, CheckedLine, CheckedTie } from '../xray-checks';
import { rankImportance, type XrayEntity } from '../xray-entities';
import { anyTieType } from '../xray-tie-types';
import type { ChronicleDraft, ChronicleRef, XraySummary } from '../xray-payload';
import type { PassRunResult } from './pass-run';
import type { PassUnit } from './pass-units';

export interface PassPayloadParts {
  entities: XrayEntity[];
  lines: CheckedLine[];
  facts: CheckedFact[];
  ties: CheckedTie[];
  summaries: XraySummary[];
  chronicle: ChronicleDraft;
}

const last = (unit: PassUnit) => unit.ordinals.at(-1)!;

/** A unit's end: its section's end when it closes the section, else its last sentence. */
export function unitEnd(unit: PassUnit, anchor: (ordinal: number) => BookKnowledgeXrayAnchor): BookKnowledgeXrayAnchor {
  return unit.sectionEnd ? { s: unit.s, end: true, n: last(unit) } : anchor(last(unit));
}

/**
 * The pass as the payload: `chronicle` per the contract, under each entity or, for what was written
 * before a join, under the join; and the round 4 fields from the same answers so the graders still
 * run (lines from `about`, profiles from identity facts, ties, summaries). Data written before a join
 * stays out of the round 4 fields, which have no place for it.
 */
const PARENT_NAME = /^(?:(?:her|his|their|the)\s+)?(?:mom|mum|mama|mother|dad|papa|father|grand(?:mother|father|ma|pa))$/i;

/** The model often flips family ties; an entry called "Mom" or "Dad" is the parent whichever way the answer reads. */
export function kinOrder<T extends { name: string }>(pair: [T, T], type: string): [T, T] {
  if (type !== 'parent_of' && type !== 'grandparent_of') return pair;
  const [a, b] = pair;
  return !PARENT_NAME.test(a.name.trim()) && PARENT_NAME.test(b.name.trim()) ? [b, a] : pair;
}

export function passPayload(
  result: PassRunResult,
  mode: BookKnowledgeXrayMode,
  anchor: (ordinal: number) => BookKnowledgeXrayAnchor,
  sentences?: readonly Sentence[],
): PassPayloadParts {
  const { cast, state } = result;
  const end = (unit: PassUnit) => unitEnd(unit, anchor);
  const refOf = (id: string): ChronicleRef | null => {
    const slot = state.slots.get(id);
    if (!slot) return null;
    const own = slot.member ?? slot.head;
    const head = cast.headOf(own);
    return head === own ? { entity: own, join: null } : { entity: head, join: own.key };
  };

  const entities: ChronicleDraft['entities'] = [];
  const lines: CheckedLine[] = [];
  const facts: CheckedFact[] = [];
  for (const id of state.slots.keys()) {
    const ref = refOf(id);
    if (!ref) continue;
    const timeline = state.timeline.get(id) ?? [];
    const value: StoryGuideChronicleEntity = {
      about: (state.about.get(id) ?? []).map((version) => ({ through: end(version.unit), text: version.value })),
      timeline: timeline.map((entry) => ({
        through: end(entry.unit),
        chapter: null,
        note: entry.value.note,
        at: anchor(entry.value.at ?? entry.unit.ordinals[0]),
      })),
    };
    const now = state.now.get(id);
    if (now?.length) value.now = now.map((version) => ({ through: end(version.unit), text: version.value }));
    const abilities = state.abilities.get(id);
    if (abilities?.length)
      value.abilities = abilities.map((snapshot) => ({
        through: end(snapshot.unit),
        items: snapshot.value.map((item) => ({ group: item.group, name: item.name, detail: item.detail, since: anchor(item.since) })),
      }));
    entities.push({ ref, value });
    if (ref.join !== null) continue;
    for (const version of state.about.get(id) ?? []) lines.push({ entity: ref.entity, text: version.value, cites: [], through: last(version.unit) });
    for (const fact of state.facts.get(id) ?? []) facts.push({ entity: ref.entity, text: fact.value.text, cite: fact.value.cite });
  }

  const pairs: ChronicleDraft['pairs'] = [];
  for (const pair of state.pairs.values()) {
    const [a, b] = [refOf(pair.a.id), refOf(pair.b.id)];
    if (a && b) pairs.push({ a, b, versions: pair.versions.map((version) => ({ through: end(version.unit), text: version.value })) });
  }

  const ties: CheckedTie[] = [];
  for (const { value } of state.ties) {
    // A skill, stat or spell is a character's ability, and a person or creature is never a possession.
    if (mode === 'fiction' && value.type === 'owns' && (value.b.head.kind === 'idea' || value.b.head.kind === 'character')) continue;
    const [a, b] = kinOrder([value.a, value.b], value.type).map((slot) => refOf(slot.id));
    if (a?.join === null && b?.join === null && a.entity !== b.entity) ties.push({ a: a.entity, type: value.type, b: b.entity, cite: value.cite });
  }
  // A one-way tie the model also gave the other way round (each teaches the other) is a guess either way.
  const way = (tie: CheckedTie, flip = false) => [flip ? tie.b.id : tie.a.id, tie.type, flip ? tie.a.id : tie.b.id].join('|');
  const ways = new Set(ties.map((tie) => way(tie)));
  const oneWay = ties.filter((tie) => anyTieType(tie.type)?.symmetric !== false || !ways.has(way(tie, true)));

  const heads = [...cast.heads];
  if (sentences) {
    const partners = new Map<XrayEntity, Set<XrayEntity>>();
    const connect = (a: XrayEntity, b: XrayEntity) => {
      const own = partners.get(a) ?? new Set<XrayEntity>();
      own.add(b);
      partners.set(a, own);
    };
    for (const { a, b } of oneWay) {
      connect(a, b);
      connect(b, a);
    }
    // A head is also named by its members from their joins on, so their sentences and names count toward its spread and dialogue.
    const mentions = cast.headMentions();
    rankImportance(
      heads,
      sentences,
      new Map([...partners].map(([entity, own]) => [entity, own.size])),
      (entity) => mentions.get(entity) ?? entity.ordinals,
      (entity) => [...entity.names.map(({ text }) => text), ...entity.joins.flatMap((join) => [join.name, ...join.names.map(({ text }) => text)])],
    );
  }

  return {
    entities: heads,
    lines,
    facts,
    ties: oneWay,
    summaries: state.summaries.map((summary) => ({ text: summary.value, ordinal: last(summary.unit) })),
    chronicle: { entities, pairs },
  };
}
