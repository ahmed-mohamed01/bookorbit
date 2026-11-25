import type { BookKnowledgeXrayMode, StoryGuideChronicleAbilityGroup } from '@bookorbit/types';
import { lineProblem, namedLater, type LineNames } from '../../../story-guides/pipeline/lines-step';
import { summaryProblem } from '../../../story-guides/pipeline/summaries-step';
import type { Sentence } from '../../core/model';
import { guessesGender, type Read, type Rejections } from '../xray-checks';
import type { XrayTieType } from '../xray-tie-types';
import type { PassSlot } from '../pass/pass-cast';
import { ABILITY_GROUPS } from '../pass/pass-prompt';
import {
  EMPTY_FACT,
  HEDGES,
  list,
  record,
  text,
  words,
  type PassAbility,
  type PassFact,
  type PassMergeProposal,
  type PassTie,
} from '../pass/pass-read';
import type { PassUnit } from '../pass/pass-units';
import { citesIn } from './dense-chunks';
import type { SceneLinkPair } from './dense-links';
import { CHUNK_NOTE_WORDS, FACTS_PER_ID, type DenseFailure } from './dense-prompt';
import { clean, descriptionProblem } from './dense-describe';
import { mapTieType } from './dense-tie-map';

const FACT_WORDS = 40;
const TIE_SENTENCE_WORDS = 40;
/** Bare words that name no ability on their own. */
const GENERIC_ABILITY = /^(?:skills?|levels?|powers?|abilit(?:y|ies)|class(?:es)?|spells?|stats?|traits?|gear|items?|magic|status)$/i;
/** leads_to needs a cited sentence that says one thing brings about another. */
const CAUSAL =
  /\b(?:caus\w*|lead(?:s|ing)? to|led to|result\w*|because|bring\w* about|brought about|produc\w*|driv\w*|enabl\w*|therefore|thus|consequen\w*|so that|give[sn]? rise|gave rise|trigger\w*)\b/i;
/** A sentence that says two names are one: a copula, "called", "known as", or apposition. */
const SAME = /\b(?:is|was|are|were|called|named|known as|alias|real name|also)\b|,/i;

export interface DenseChunkInput {
  chunk: PassUnit;
  slots: readonly PassSlot[];
  sentences: readonly Sentence[];
  mode: BookKnowledgeXrayMode;
  /** Names a reader at the chunk's end has and has not met. */
  names: LineNames;
  /** Each slot's sentences in the chunk, fixed at launch; a tie cited on a sentence that does not name both sides moves to the chunk's end. */
  mentions?: ReadonlyMap<string, ReadonlySet<number>>;
}

function firstNaming(ordinals: readonly number[], sentences: readonly Sentence[], a: PassSlot, b: PassSlot): number | undefined {
  const names = (slot: PassSlot) => [slot.name, ...slot.aliases].map((name) => name.toLowerCase());
  const [left, right] = [names(a), names(b)];
  return ordinals.find((ordinal) => {
    const line = sentences[ordinal - 1].text.toLowerCase();
    return left.some((name) => line.includes(name)) && right.some((name) => line.includes(name));
  });
}

function count(rejected: Rejections, reason: string, by = 1): void {
  if (by) rejected[reason] = (rejected[reason] ?? 0) + by;
}

function lookupOf(slots: readonly PassSlot[]) {
  const ids = new Map(slots.map((slot) => [slot.id, slot]));
  return (id: unknown) => ids.get(String(id).replace(/^\*/, '').trim());
}

export interface DenseNotes {
  notes: { slot: PassSlot; note: string; cites: number[] }[];
  /** Ids answered with null: nothing happens to them here. */
  nulls: PassSlot[];
  /** Every id the reply gave a key, a note, a null or a note that failed a check. */
  answered: Set<string>;
  /** null when the reply had none or it failed a check. */
  summary: string | null;
  failed: DenseFailure[];
}

/**
 * Ask A's reply, checked: ids from the cast list, cited numbers inside the chunk (others dropped, the
 * note kept), no name a reader at the chunk's end has not met, notes within the word limit. Notes
 * come as an object keyed by id, or a list of {"id", ...}. A reply without notes and summary is unreadable.
 */
export function notesReader(input: DenseChunkInput, rejected: Rejections): Read<DenseNotes> {
  const { chunk, slots, names } = input;
  const byId = lookupOf(slots);
  const inside = new Set(chunk.ordinals);
  const later = (value: string) => namedLater(value, names);
  return (raw) => {
    const answer = record(raw);
    if (!answer || (answer.notes === undefined && answer.summary === undefined)) return null;
    const result: DenseNotes = { notes: [], nulls: [], answered: new Set(), summary: null, failed: [] };
    const entries: [unknown, unknown][] = Array.isArray(answer.notes)
      ? list(answer.notes).map((item) => [item.id, item.note === null ? null : item])
      : Object.entries(record(answer.notes) ?? {});
    for (const [id, value] of entries) {
      const slot = byId(id);
      if (!slot || result.answered.has(slot.id)) {
        count(rejected, 'notes:unknown-id');
        continue;
      }
      result.answered.add(slot.id);
      const item = record(value);
      const note = typeof value === 'string' ? text(value) : text(item?.note);
      if (!note) {
        result.nulls.push(slot);
        continue;
      }
      const { cites, outside } = citesIn(item?.n, inside);
      count(rejected, 'notes:cite-outside', outside);
      if (words(note) > CHUNK_NOTE_WORDS)
        result.failed.push({ field: 'notes', id: slot.id, text: note, detail: `is longer than ${CHUNK_NOTE_WORDS} words` });
      else if (later(note).length)
        result.failed.push({ field: 'notes', id: slot.id, text: note, detail: `names ${later(note).join(', ')}, not introduced yet` });
      else result.notes.push({ slot, note, cites });
    }
    const summary = text(answer.summary);
    const problem = summary ? summaryProblem(summary, names) : null;
    if (problem) result.failed.push({ field: 'summary', id: 'summary', text: summary, detail: problem.detail });
    else result.summary = summary || null;
    return { items: result, rejected: {} };
  };
}

export interface DenseFacts {
  facts: PassFact[];
  descriptions: PassFact[];
  abilities: PassAbility[];
  merges: PassMergeProposal[];
  failed: DenseFailure[];
}

/**
 * Ask B's reply, checked: ids from the cast list, at least one cited number inside the chunk, at most
 * `FACTS_PER_ID` facts an id, no gender the chunk never gives, no hedge, no later name; an ability's
 * name must be in its cited sentence and be more than a bare generic word; a merge only on a sentence
 * naming both that says they are one. Facts that break a writing rule come back in `failed` for one retry.
 */
export function factsReader(input: DenseChunkInput, rejected: Rejections, needsIs: ReadonlySet<string> = new Set()): Read<DenseFacts> {
  const { chunk, slots, sentences, mode, names } = input;
  const byId = lookupOf(slots);
  const inside = new Set(chunk.ordinals);
  const later = (value: string) => namedLater(value, names);
  const said = (ordinals: readonly number[]) => ordinals.map((ordinal) => sentences[ordinal - 1].text).join(' ');
  const about = (slot: PassSlot) => {
    const own = [slot.name, ...slot.aliases].map((name) => name.toLowerCase());
    return chunk.ordinals.map((ordinal) => sentences[ordinal - 1].text).filter((line) => own.some((name) => line.toLowerCase().includes(name)));
  };
  const cited = (field: string, value: unknown) => {
    const { cites, outside } = citesIn(value, inside);
    count(rejected, `${field}:cite-outside`, outside);
    if (!cites.length) count(rejected, `${field}:no-cite`);
    return cites;
  };
  return (raw) => {
    const answer = record(raw);
    if (!answer || !['identity', 'abilities', 'merges'].some((key) => Array.isArray(answer[key]))) return null;
    const result: DenseFacts = { facts: [], descriptions: [], abilities: [], merges: [], failed: [] };
    const fail = (field: DenseFailure['field'], id: string, value: string, detail: string) => result.failed.push({ field, id, text: value, detail });

    const described = new Set<string>();
    const perId = new Map<string, Set<string>>();
    for (const item of list(answer.identity)) {
      const slot = byId(item.id);
      const fact = text(item.fact);
      const description = record(item.is);
      if (slot && description && needsIs.has(slot.id) && !described.has(slot.id)) {
        const own = [slot.name, ...slot.aliases];
        const raw = text(description.text);
        const line = clean(raw, own);
        const { cites, outside } = citesIn(description.n, inside);
        const cite = cites.find((ordinal) => own.some((name) => sentences[ordinal - 1].text.toLowerCase().includes(name.toLowerCase())));
        const problem = words(raw) > 12 ? 'too-long' : descriptionProblem(line, names, own, 12);
        if (problem || outside || cite === undefined) count(rejected, `is:${problem ?? 'no-cite'}`);
        else {
          described.add(slot.id);
          result.descriptions.push({ slot, text: line, cite });
        }
      }
      if (!slot || (!fact && !description)) {
        count(rejected, 'identity:unknown-id');
        continue;
      }
      if (!fact) continue;
      const seen = perId.get(slot.id) ?? new Set<string>();
      const key = fact.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
      if (seen.has(key) || seen.size >= FACTS_PER_ID) {
        count(rejected, 'identity:over-limit');
        continue;
      }
      const cites = cited('identity', item.n);
      if (!cites.length) continue;
      if (EMPTY_FACT.test(fact)) {
        count(rejected, 'identity:empty');
        continue;
      }
      if (guessesGender(fact, about(slot))) {
        count(rejected, 'identity:gender-guess');
        continue;
      }
      seen.add(key);
      perId.set(slot.id, seen);
      const problem = mode === 'fiction' ? lineProblem(fact, { later: names.later, visible: names.visible }) : null;
      const id = `${slot.id}#${seen.size}`;
      if (words(fact) > FACT_WORDS) fail('identity', id, fact, `is longer than ${FACT_WORDS} words`);
      else if (HEDGES.test(fact)) fail('identity', id, fact, 'hedges ("possibly", "perhaps", "seems")');
      else if (later(fact).length) fail('identity', id, fact, `names ${later(fact).join(', ')}, not introduced yet`);
      else if (problem && problem.reason !== 'too-long') fail('identity', id, fact, problem.detail);
      else result.facts.push({ slot, text: fact, cite: cites[0], ...(mode === 'fiction' && item.kind === 'status' ? { status: true } : {}) });
    }

    if (mode === 'fiction')
      for (const item of list(answer.abilities)) {
        const slot = byId(item.id);
        const name = text(item.name);
        if (!slot || !name) {
          count(rejected, 'abilities:unknown-id');
          continue;
        }
        const cites = cited('abilities', item.n);
        if (!cites.length) continue;
        if (GENERIC_ABILITY.test(name)) {
          count(rejected, 'abilities:generic-name');
          continue;
        }
        if (!said(cites).toLowerCase().includes(name.toLowerCase())) {
          count(rejected, 'abilities:name-not-in-sentence');
          continue;
        }
        const change = item.change === 'lost' || item.change === 'changed' ? item.change : 'gained';
        const group = (ABILITY_GROUPS as readonly string[]).includes(String(item.group)) ? (item.group as StoryGuideChronicleAbilityGroup) : 'other';
        result.abilities.push({ slot, change, group, name, detail: text(item.detail) || null, cite: cites[0] });
      }

    for (const item of list(answer.merges)) {
      const [a, b] = [byId(item.a), byId(item.b)];
      const cites = citesIn(item.n, inside).cites;
      const line = said(cites).toLowerCase();
      const named = (slot: PassSlot) => [slot.name, ...slot.aliases].some((name) => line.includes(name.toLowerCase()));
      if (!a || !b || a.head === b.head || !cites.length || !named(a) || !named(b) || !SAME.test(line)) {
        count(rejected, 'merges:not-stated');
        continue;
      }
      result.merges.push({ a, b, cite: cites[0] });
    }
    return { items: result, rejected: {} };
  };
}

export interface SceneSamePair {
  a: PassSlot;
  b: PassSlot;
}

export interface DenseScene {
  pov: string | null;
  same: SceneSamePair[];
  ties: PassTie[];
  linkPairs: SceneLinkPair[];
  relations: number;
  mapped: Rejections;
}

export function orientTie(a: PassSlot, b: PassSlot, { from, to, symmetric }: XrayTieType): [PassSlot, PassSlot] | null {
  const fits = (left: PassSlot, right: PassSlot) => from.includes(left.kind) && to.includes(right.kind);
  if (!fits(a, b)) {
    if (!fits(b, a)) return null;
    [a, b] = [b, a];
  }
  return symmetric && b.head.key < a.head.key ? [b, a] : [a, b];
}

// Standing in a throne room or a pyramid is not living there; the sentences must say it.
const DWELLING =
  /\b(?:liv(?:e|es|ed|ing)|home|homes|house[ds]?|dwell\w*|resid\w*|stay(?:s|ed|ing)?|settled|quarters|lodg\w*|apartment|bunk\w*|moved (?:in|into))\b/i;

export function tieProblem(info: XrayTieType | undefined, evidence: string, sentence: string, names: () => LineNames): string | null {
  if (info?.type === 'leads_to' && !CAUSAL.test(evidence)) return 'leads-to-not-stated';
  if (info?.type === 'lives_at' && !DWELLING.test(evidence)) return 'lives-at-not-stated';
  if (!sentence || words(sentence) > TIE_SENTENCE_WORDS) return 'sentence-length';
  if (namedLater(sentence, names()).length) return 'later-name';
  if (HEDGES.test(sentence)) return 'hedge';
  return null;
}

const rosterName = (name: string) => name.toLowerCase().replace(/^the\s+/, '');

export function sceneReader(input: DenseChunkInput, rejected: Rejections): Read<DenseScene> {
  const { chunk, slots, sentences, mode, names, mentions } = input;
  const byId = lookupOf(slots);
  const byName = new Map<string, PassSlot | null>();
  for (const slot of slots)
    for (const name of [slot.name, ...slot.aliases]) {
      const key = rosterName(name);
      byName.set(key, byName.has(key) && byName.get(key) !== slot ? null : slot);
    }
  const resolve = (value: unknown) => byId(value) ?? byName.get(rosterName(text(value)));
  const inside = new Set(chunk.ordinals);
  const said = (ordinals: readonly number[]) => ordinals.map((ordinal) => sentences[ordinal - 1].text).join(' ');
  return (raw) => {
    const given = record(raw);
    if (!given || !('pov' in given || Array.isArray(given.same) || Array.isArray(given.relations))) return null;
    const pov = mode === 'fiction' ? (resolve(given.pov)?.id ?? null) : null;
    const relations: unknown[] = Array.isArray(given.relations) ? given.relations : [];
    const result: DenseScene = { pov, same: [], ties: [], linkPairs: [], relations: relations.length, mapped: {} };
    for (const value of Array.isArray(given.same) ? given.same : []) {
      const item = record(value);
      const a = resolve(item?.id);
      const b = resolve(item?.same_as);
      // The two-chunk vote guards a same-entity answer, so a missing sentence number does not void it.
      if (!a || !b) count(rejected, 'scene:same-unknown');
      // A reply often pairs an entry with itself; counting that apart keeps same-already to pairs the cast had joined.
      else if (a === b) count(rejected, 'scene:same-self');
      else if (a.head === b.head) count(rejected, 'scene:same-already');
      else result.same.push({ a, b });
    }
    count(rejected, 'ties:over-limit', Math.max(0, relations.length - 12));
    for (const value of relations.slice(0, 12)) {
      const item = record(value);
      if (!item) {
        count(rejected, 'ties:invalid-relation');
        continue;
      }
      let [a, b] = [resolve(item.a), resolve(item.b)];
      if (!a || !b || a.head === b.head) {
        count(rejected, 'ties:not-the-pair');
        continue;
      }
      const type = mapTieType(item.type, mode);
      if (!type) count(rejected, text(item.type).toLowerCase() === 'related' ? 'ties:related' : 'ties:unknown-type');
      else {
        if (type.mapped) count(result.mapped, type.mapped);
        if (type.reversed) [a, b] = [b, a];
      }
      const cited = citesIn(item.n, inside);
      count(rejected, 'ties:cite-outside', cited.outside);
      // A relation the card gives without a number rests on the first sentence of the stretch that names both sides.
      const found = cited.cites.length ? undefined : firstNaming(chunk.ordinals, sentences, a, b);
      if (found) count(rejected, 'ties:cite-found');
      const cites = found ? [found] : cited.cites;
      if (!cites.length) {
        count(rejected, 'ties:no-cite');
        continue;
      }
      const oriented = type && orientTie(a, b, type.info);
      if (type && !oriented) count(rejected, 'ties:kinds-link');
      if (oriented) [a, b] = oriented;
      const info = oriented ? type?.info : undefined;
      const sentence = text(item.sentence);
      const problem = tieProblem(info, said(cites), sentence, () => names);
      if (problem) count(rejected, `ties:${problem}`);
      else {
        const named = (slot: PassSlot) => mentions?.get(slot.id)?.has(cites[0]) ?? true;
        const cite = named(a) && named(b) ? cites[0] : chunk.ordinals.at(-1)!;
        if (cite !== cites[0]) count(rejected, 'ties:cite-moved');
        result.linkPairs.push({ a: a.member ?? a.head, b: b.member ?? b.head, cite });
        if (info) result.ties.push({ a, b, type: info.type, sentence, cite });
      }
    }
    return { items: result, rejected: {} };
  };
}
