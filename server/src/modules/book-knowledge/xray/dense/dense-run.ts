import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { namedLater, type LineNames } from '../../../story-guides/pipeline/lines-step';
import type { AiEffort } from '../../../ai/ai-client.types';
import type { Sentence } from '../../core/model';
import type { Rejections } from '../xray-checks';
import { proseProblem } from '../xray-description-context';
import type { XrayEntity } from '../xray-entities';
import { namesAt } from '../xray-lines';
import { type XrayStepRun } from '../xray-runner';
import { NARRATOR_ID, PassCast, patternMerges, type PassSlot } from '../pass/pass-cast';
import { NOTE_WORDS } from '../pass/pass-prompt';
import { HEDGES, NARRATOR_PHRASE, record, text, words, type PassAnswer, type PassFact } from '../pass/pass-read';
import { aboutSince, cloned, outgrown, writeAbout, type AboutEvidence, type Ask, type PassRunResult } from '../pass/pass-run';
import { ungroundedNames } from '../pass/pass-grounding';
import { factsAbout, PassState } from '../pass/pass-state';
import type { PassUnit } from '../pass/pass-units';
import { denseChunks, numberedText } from './dense-chunks';
import {
  factsUser,
  factsOutputTokens,
  notesUser,
  readSystem,
  notesOutputTokens,
  notesBatchUser,
  RETRY_BATCH,
  sceneUser,
  TIES_MAX_OUTPUT_TOKENS,
  NOW_MAX_OUTPUT_TOKENS,
  NOW_MOMENT,
  NOW_SYSTEM,
  NOW_WORDS,
  nowUser,
  requiredIds,
  retryUser,
  type DenseContext,
  type DenseFailure,
} from './dense-prompt';
import { aliasCandidates, aliasMerges, epithetFolds, joinAlias } from './dense-alias';
import { identityMerges, type IdentityEvidence } from './dense-identity';
import { describeEntities, descriptionProblem, sharedLines, IDENTITY, IDENTITY_PROSE, PROTAGONIST } from './dense-describe';
import { bareLabel, definitionGloss, definitionOf, sameText } from './dense-definition';
import type { SceneLinkPair } from './dense-links';
import {
  factsReader,
  NO_ACTOR,
  notesReader,
  sceneReader,
  type DenseChunkInput,
  type DenseFacts,
  type DenseNotes,
  type DenseScene,
} from './dense-read';
import { NarrationDetector, NarratorVotes } from './dense-narration';
import { sceneRoster, SceneRelations, SceneSame } from './dense-scene';
import { MINOR_TIER, slotTier } from '../xray-tiers';
import { indexSystemLines } from '../xray-system-tags';

const DENSE_EFFORT: AiEffort = 'low';
/** Units an entry with no line is sent to the describe step before it is left to its facts. */
export const DESCRIBE_TRIES = 4;
/**
 * Units read at once: a unit launches once the unit this many places before it is processed, and its prompt shows
 * what was stamped by then, so two runs of one book send the same prompts.
 */
export const DENSE_UNIT_WINDOW = 2;

export interface DenseRunInput {
  entities: readonly XrayEntity[];
  sentences: readonly Sentence[];
  units: readonly PassUnit[];
  mode: BookKnowledgeXrayMode;
  readDescription?: () => Promise<string | null>;
  ask: Ask;
  /** The describe and now steps, which write entry text. */
  askWrite: Ask;
  askAbout: Ask;
  /** Ask A: notes and summary. */
  notes: XrayStepRun;
  /** Ask B: identity facts, abilities and merges. */
  facts: XrayStepRun;
  /** Ask C: one scene card per chunk. */
  ties: XrayStepRun;
  /** Same or different for the alias candidates, before the pass. */
  alias: XrayStepRun;
  /** Lines for entries the facts ask and the glosses left without one. */
  describe: XrayStepRun;
  /** The main cast's `now` lines. */
  now: XrayStepRun;
  about: XrayStepRun;
  /** Who gets a model-written `about`: the main cast; the rest get theirs from their facts by code. */
  writesAbout: (slot: PassSlot) => boolean;
  /** Called once the units are about to be read, then after each unit is processed. */
  onUnit?: (done: number, total: number) => void;
}

export interface DenseRunResult extends PassRunResult {
  /** Required note keys asked for, answered on the first try, and answered once the re-asks are in. */
  required: { keys: number; first: number; retry: number };
  linkPairs: SceneLinkPair[];
  pov: Map<string, string | null>;
}

/** A failure's reason without its text, for the first-try tally. */
function reasonOf(item: DenseFailure): string {
  const kind = /longer than|needs one sentence/.test(item.detail)
    ? 'too-long'
    : /not introduced yet/.test(item.detail)
      ? 'later-name'
      : /hedges/.test(item.detail)
        ? 'hedge'
        : item.detail === NO_ACTOR
          ? 'no-actor'
          : 'rule';
  return `${item.field}:${kind}`;
}

const factKey = (fact: string) =>
  fact
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export function stitchNotes(notes: readonly { note: string; cites: readonly number[] }[]): string {
  const seen = new Set<string>();
  const texts = [...notes]
    .sort((a, b) => (a.cites[0] ?? Infinity) - (b.cites[0] ?? Infinity))
    .flatMap(({ note }) => {
      const key = factKey(note);
      if (seen.has(key)) return [];
      seen.add(key);
      return [note];
    });
  const kept: string[] = [];
  let used = 0;
  for (const note of texts) {
    const size = words(note);
    if (kept.length && used + size > NOTE_WORDS) break;
    kept.push(note);
    used += size;
  }
  return kept.join(' ');
}

/** The chunk sentences that name any of `slots`, for a re-ask that sends only the evidence. */
function evidenceOf(slots: readonly PassSlot[], seen: ReadonlyMap<string, readonly number[]>): number[] {
  return [...new Set(slots.flatMap((slot) => seen.get(slot.id) ?? []))].sort((a, b) => a - b);
}

function add(counts: Rejections, key: string, by = 1): void {
  if (by) counts[key] = (counts[key] ?? 0) + by;
}

/** A promise whose failure is reported where it is awaited, not as an unhandled rejection before then. */
function held<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

interface LaunchedChunk {
  slots: PassSlot[];
  /** Set on a first-person chunk: records its point of view once its answers are applied. */
  narratorDone?: (pov: string | null) => Promise<void>;
  chunk: PassUnit;
  notes: Promise<DenseNotes | null>;
  facts: Promise<DenseFacts | null>;
  scene: Promise<DenseScene | null>;
  glosses: PassFact[];
}

interface LaunchedUnit {
  unit: PassUnit;
  slots: PassSlot[];
  chunks: LaunchedChunk[];
  joined: Promise<PassAnswer['notes']>;
}

export async function runDense(input: DenseRunInput): Promise<DenseRunResult> {
  const { sentences, units, mode, ask } = input;
  const systemTagFor = mode === 'fiction' ? indexSystemLines(sentences, units.at(-1)?.ordinals.at(-1) ?? 0) : undefined;
  const kindFor = (slot: PassSlot, through: number) => {
    const tag = slot.kind !== 'character' && systemTagFor?.([slot.name, ...slot.aliases], through);
    return tag ? `${slot.kind} | ${tag}` : slot.kind;
  };
  const entities = cloned(input.entities);
  const cast = new PassCast(entities);
  for (const merge of patternMerges(entities, sentences, { guard: true })) cast.merge(merge);
  const identity = resolveIdentities(cast, sentences, mode, input.alias);
  const pattern = cast.merges.length;
  const offered = aliasCandidates(cast, sentences, mode, identity);
  for (const merge of await aliasMerges(offered, sentences, mode, ask, input.alias)) joinAlias(cast, merge);
  // A join opens pairs the first round could not see ("Princess Bob" joins Viv, so "Bob" now meets her); ask only about those.
  const asked = new Set(offered.map(({ member, head }) => `${member.key}|${head.key}`));
  const opened = aliasCandidates(cast, sentences, mode).filter(
    ({ member, head }) => !asked.has(`${member.key}|${head.key}`) && !asked.has(`${head.key}|${member.key}`),
  );
  for (const merge of await aliasMerges(opened, sentences, mode, ask, input.alias, 'alias-joined')) joinAlias(cast, merge);
  const state = new PassState();
  const same = new SceneSame();
  const linkPairs: SceneLinkPair[] = [];
  const pov = new Map<string, string | null>();
  const relations = new SceneRelations();
  const narrationDetector = new NarrationDetector();
  const narrators = new NarratorVotes(cast, input.readDescription);
  // Once the narrator is settled, their own entry may be called the narrator; everyone else is still named.
  const isNarrator = (slot: PassSlot) => {
    const settled = narrators.settled;
    return slot.id === NARRATOR_ID || (settled !== null && cast.headOf(settled) === cast.headOf(slot.member ?? slot.head));
  };
  const required = { keys: 0, first: 0, retry: 0 };
  const namesFor = (ordinal: number): LineNames => namesAt(entities, ordinal);
  let rewrites = 0;
  const describeTries = new Map<string, number>();
  const shared = new Map<string, number>();
  const minorCharacter = (slot: PassSlot) => slot.kind === 'character' && slotTier(slot, mode) === MINOR_TIER;
  const notesThrough = (id: string, through: number, since = 0) =>
    (state.timeline.get(id) ?? []).flatMap(({ unit: source, value: { note, at } }) => {
      const end = source.ordinals.at(-1) ?? Infinity;
      const anchor = at ?? end;
      return note && end <= through && anchor <= through && anchor > since ? [{ note, at: anchor }] : [];
    });

  const describeGaps = async (unit: PassUnit, slots: readonly PassSlot[], names: LineNames, minorIntros: ReadonlyMap<string, string>) => {
    const through = unit.ordinals.at(-1)!;
    const pending = slots.flatMap((slot) => {
      const sharedAt = shared.get(slot.id);
      const retry = state.currentAbout(slot.id) !== null;
      if (retry && sharedAt === undefined) return [];
      const notes = minorCharacter(slot) ? notesThrough(slot.id, through) : [];
      const intro = minorIntros.get(slot.id);
      if (!retry && intro && !notes.length) {
        state.setAbout(slot.id, unit, intro);
        return [];
      }
      const tried = describeTries.get(slot.id) ?? 0;
      if (!retry && tried >= DESCRIBE_TRIES) return [];
      const mentions = cast.mentionsOf(slot, unit);
      if (mentions.length <= (sharedAt ?? 0)) return [];
      if (retry) shared.delete(slot.id);
      else {
        describeTries.set(slot.id, tried + 1);
        if (tried) input.describe.reject({ 'describe:deferred': 1 });
      }
      return [{ slot, mentions, notes, retry }];
    });
    if (pending.length) {
      input.describe.tally('counts', { 'describe:gap': pending.length });
      const lines = await describeEntities(pending, unit.id, names, sentences, mode, input.askWrite, input.describe, isNarrator, (slot) =>
        kindFor(slot, through),
      );
      const duplicates = sharedLines(lines);
      if (duplicates.size) input.describe.tally('counts', { 'describe:shared': duplicates.size });
      for (const {
        slot: { id },
        mentions,
        retry,
      } of pending) {
        const line = lines.get(id);
        if (line === undefined) continue;
        if (duplicates.has(id)) {
          if (retry) continue;
          shared.set(id, mentions.length);
        }
        state.setAbout(id, unit, line);
      }
    }
    for (const [id, intro] of minorIntros) if (!state.currentAbout(id)) state.setAbout(id, unit, intro);
  };

  /** `seen`: each slot's sentences in the chunk, fixed at launch. `others`: the chunk's facts and scene asks are done. */
  const askNotes = async (
    chunk: DenseChunkInput,
    context: DenseContext,
    firstResponse: () => void,
    seen: ReadonlyMap<string, readonly number[]>,
    others: Promise<void>,
  ): Promise<DenseNotes | null> => {
    const system = readSystem(mode);
    const user = notesUser(numberedText(sentences, chunk.chunk.ordinals), chunk.slots, context, mode);
    const rejected: Rejections = {};
    const read = notesReader(chunk, rejected);
    const send = (body: string, slots: readonly PassSlot[] = chunk.slots) =>
      ask({ system, user: body, maxOutputTokens: notesOutputTokens(slots), effort: DENSE_EFFORT, capped: true });
    const wanted = requiredIds(chunk.slots, mode);
    required.keys += wanted.length;
    const replied = await input.notes
      .unit({ id: chunk.chunk.id, ordinals: chunk.chunk.ordinals, send: send(user), read, tries: 1 })
      .finally(firstResponse);
    const answer: DenseNotes = replied ?? { notes: [], nulls: [], answered: new Set(), summary: null, failed: [] };
    const missing = wanted.filter((id) => !answer.answered.has(id));
    required.first += wanted.length - missing.length;
    const first: Rejections = { ...rejected };
    for (const item of answer.failed) add(first, reasonOf(item));
    add(first, 'notes:missing-required', replied ? missing.length : 0);
    add(first, 'notes:unreadable-or-cut', replied ? 0 : 1);
    input.notes.tally('firstTry', first);

    const failedNotes = answer.failed.filter((item) => item.field === 'notes');
    const redo = [...new Set([...missing, ...failedNotes.map((item) => item.id)])];
    let summaryWanted = !replied || answer.failed.some((item) => item.field === 'summary');
    const batches: string[][] = [];
    for (let at = 0; at < redo.length; at += RETRY_BATCH) batches.push(redo.slice(at, at + RETRY_BATCH));
    if (!batches.length && summaryWanted) batches.push([]);
    if (batches.length) rewrites++;
    const again = await Promise.all(
      batches.map(async (ids, index) => {
        const slots = chunk.slots.filter((slot) => ids.includes(slot.id));
        // The summary needs the whole chunk; a names-only re-ask needs just their sentences.
        const whole = summaryWanted && index === 0;
        const ordinals = whole ? chunk.chunk.ordinals : evidenceOf(slots, seen);
        // An evidence-only prompt shares no prefix with the chunk's, so on a one-slot server it waits for the chunk's other asks to use the cache.
        if (!whole) await others;
        return input.notes.unit({
          id: `${chunk.chunk.id}r${index + 1}`,
          ordinals,
          send: send(
            notesBatchUser(
              notesUser(numberedText(sentences, ordinals), slots, context, mode),
              ids,
              failedNotes.filter((item) => ids.includes(item.id)),
              summaryWanted && index === 0,
            ),
            slots,
          ),
          read: notesReader({ ...chunk, chunk: { ...chunk.chunk, ordinals }, slots, cast: chunk.cast ?? chunk.slots }, rejected),
          tries: 1,
        });
      }),
    );
    const fixing = new Set(redo);
    again.forEach((reply, index) => {
      const asked = new Set(batches[index]);
      for (const note of reply?.notes ?? []) if (asked.has(note.slot.id) && fixing.delete(note.slot.id)) answer.notes.push(note);
      for (const slot of reply?.nulls ?? []) if (asked.has(slot.id) && fixing.delete(slot.id)) answer.nulls.push(slot);
      for (const id of reply?.answered ?? []) if (asked.has(id) && wanted.includes(id)) answer.answered.add(id);
      if (index === 0 && summaryWanted && reply?.summary) {
        answer.summary = reply.summary;
        summaryWanted = false;
      }
    });
    if (summaryWanted) add(rejected, 'summary:lost');
    for (const id of fixing) add(rejected, missing.includes(id) ? 'notes:still-missing' : 'notes:rewrite-failed');
    required.retry += wanted.filter((id) => answer.answered.has(id)).length;
    input.notes.reject(rejected);
    return answer;
  };

  const askFacts = async (
    chunk: DenseChunkInput,
    context: DenseContext,
    seen: ReadonlyMap<string, readonly number[]>,
  ): Promise<DenseFacts | null> => {
    const system = readSystem(mode);
    const user = factsUser(numberedText(sentences, chunk.chunk.ordinals), chunk.slots, context, mode);
    const rejected: Rejections = {};
    const read = factsReader(chunk, rejected, context.needsIs);
    const send = (body: string, slots: readonly PassSlot[]) =>
      ask({ system, user: body, maxOutputTokens: factsOutputTokens(slots, context.needsIs), effort: DENSE_EFFORT, capped: true });
    const answer = await input.facts.unit({ id: chunk.chunk.id, ordinals: chunk.chunk.ordinals, send: send(user, chunk.slots), read });
    if (!answer) {
      input.facts.reject(rejected);
      return null;
    }
    const first: Rejections = { ...rejected };
    for (const item of answer.failed) add(first, reasonOf(item));
    input.facts.tally('firstTry', first);
    if (answer.failed.length) {
      rewrites++;
      const slots = chunk.slots.filter((slot) => answer.failed.some((item) => item.id.split('#')[0] === slot.id));
      const ordinals = evidenceOf(slots, seen);
      const again = await input.facts.unit({
        id: `${chunk.chunk.id}r`,
        ordinals,
        send: send(retryUser(factsUser(numberedText(sentences, ordinals), slots, context, mode), [], answer.failed), slots),
        read: factsReader({ ...chunk, chunk: { ...chunk.chunk, ordinals }, slots }, rejected, context.needsIs),
      });
      const factsFor = new Map<string, number>();
      for (const item of answer.failed) factsFor.set(item.id.split('#')[0], (factsFor.get(item.id.split('#')[0]) ?? 0) + 1);
      let fixed = 0;
      // A retry that repeats a fact the first reply already gave would use up the slot and then be dropped as a repeat.
      const given = new Set(answer.facts.map((fact) => `${fact.slot.id}\u0000${factKey(fact.text)}`));
      for (const fact of again?.facts ?? []) {
        const left = factsFor.get(fact.slot.id) ?? 0;
        if (!left || given.has(`${fact.slot.id}\u0000${factKey(fact.text)}`)) continue;
        factsFor.set(fact.slot.id, left - 1);
        answer.facts.push(fact);
        fixed++;
      }
      add(rejected, 'facts:rewrite-failed', Math.max(0, answer.failed.length - fixed));
    }
    input.facts.reject(rejected);
    return answer;
  };

  const askScene = async (chunk: DenseChunkInput, about: ReadonlyMap<string, string>): Promise<DenseScene | null> => {
    const rejected: Rejections = {};
    const answer = await input.ties.unit({
      id: chunk.chunk.id,
      ordinals: chunk.chunk.ordinals,
      send: ask({
        system: readSystem(mode),
        user: sceneUser(numberedText(sentences, chunk.chunk.ordinals), chunk.slots, about, mode, chunk.firstPerson),
        maxOutputTokens: TIES_MAX_OUTPUT_TOKENS,
        effort: DENSE_EFFORT,
        capped: true,
      }),
      read: sceneReader(chunk, rejected),
      tries: 1,
    });
    add(rejected, answer?.pov ? 'scene:pov' : 'scene:no-pov');
    input.ties.tally('counts', {
      chunks: 1,
      relations: answer?.relations ?? 0,
      ties: answer?.ties.length ?? 0,
      linkPairs: answer?.linkPairs.length ?? 0,
    });
    input.ties.tally('mapped', answer?.mapped ?? {});
    input.ties.reject(rejected);
    return answer;
  };

  /** What a prompt shows as of sentence `through`: only what was stamped by then, however far later units have got. */
  const aboutOf = (slots: readonly PassSlot[], through: number) =>
    new Map(slots.flatMap((slot) => (state.aboutAt(slot.id, through) ? [[slot.id, state.aboutAt(slot.id, through)!]] : [])));
  const contextOf = (slots: readonly PassSlot[], through: number, within: string): DenseContext => ({
    about: aboutOf(slots, through),
    abilities: new Map(
      slots.flatMap((slot) => {
        const list = state.abilitiesText(slot.id, through, within);
        return list ? [[slot.id, list]] : [];
      }),
    ),
    previous: state.summaryAt(through),
  });

  const joinNotes = async (chunks: readonly LaunchedChunk[]): Promise<PassAnswer['notes']> => {
    const chunkNotes = new Map<string, DenseNotes['notes']>();
    for (const chunk of chunks)
      for (const note of (await chunk.notes)?.notes ?? []) chunkNotes.set(note.slot.id, [...(chunkNotes.get(note.slot.id) ?? []), note]);
    return [...chunkNotes.values()].map((notes) => {
      const at = notes.flatMap((note) => note.cites);
      return { slot: notes[0].slot, note: stitchNotes(notes), at: at.length ? Math.min(...at) : null };
    });
  };

  const launch = (unit: PassUnit, through: number): LaunchedUnit => {
    const slots = cast.slots(unit);
    const unitCast = slots;
    const launchChunk = (chunk: PassUnit, narratorId?: string): LaunchedChunk => {
      const slots = cast.slots(unit, chunk.ordinals);
      const read: DenseChunkInput = { chunk, slots, sentences, mode, names: namesFor(chunk.ordinals.at(-1)!), narratorId, unitCast };
      const context = contextOf(slots, through, chunk.ordinals.map((ordinal) => sentences[ordinal - 1].text).join('\n'));
      context.narratorId = narratorId;
      const seen = new Map(slots.map((slot) => [slot.id, cast.mentionsOf(slot, chunk, chunk.ordinals)]));
      const needsIs = new Set<string>();
      const glosses: PassFact[] = [];
      for (const slot of slots) {
        if (context.about.has(slot.id)) continue;
        const own = [slot.name, ...slot.aliases];
        const cite = slot.kind === 'character' ? null : definitionOf(seen.get(slot.id)!, sentences, own);
        const gloss = cite === null ? null : definitionGloss(sentences[cite - 1].text, own, slot.kind);
        if (gloss && cite !== null && !descriptionProblem(gloss, read.names, own, slotTier(slot, mode).limit, false, mode === 'fiction'))
          glosses.push({ slot, text: gloss, cite });
        else if (!input.writesAbout(slot)) needsIs.add(slot.id);
      }
      context.needsIs = needsIs;
      read.mentions = new Map([...seen].map(([id, ordinals]) => [id, new Set(ordinals)]));
      const roster = sceneRoster(cast, chunk, mode);
      const rosterMentions = new Map(roster.map((slot) => [slot.id, new Set(cast.mentionsOf(slot, chunk, chunk.ordinals))]));
      let firstResponse!: () => void;
      const ready = new Promise<void>((resolve) => (firstResponse = resolve));
      let othersDone!: () => void;
      const others = new Promise<void>((resolve) => (othersDone = resolve));
      const notes = held(askNotes(read, context, firstResponse, seen, others));
      const facts = held(ready.then(() => askFacts(read, context, seen)));
      const scene = held(
        ready.then(() => askScene({ ...read, slots: roster, mentions: rosterMentions, firstPerson: !!narratorId }, aboutOf(roster, through))),
      );
      void Promise.allSettled([facts, scene]).then(othersDone);
      return { chunk, slots, notes, facts, scene, glosses };
    };
    const chunks = denseChunks(sentences, unit).map((chunk): LaunchedChunk => {
      const narration = narrationDetector.mentions(chunk, sentences);
      if (!narration.length) return launchChunk(chunk);
      // Who says "I" as the votes stood at launch, the stand-in until a section or the book settles: no chunk waits on another.
      const owner = narrators.ownerAt(chunk.s, chunk.ordinals[0]) ?? narrators.anonymous(narration[0]);
      cast.creditNarration(owner, chunk, narration);
      return {
        ...launchChunk(chunk, owner.id),
        async narratorDone(pov: string | null) {
          const end = chunk.ordinals.at(-1)!;
          narrators.record(pov, end, chunk.s);
          const settled = await narrators.settle(end);
          const anonymous = cast.entity(NARRATOR_ID);
          if (settled && anonymous && cast.joinedAt(anonymous) === null)
            cast.merge({ member: anonymous, head: cast.headOf(settled), ordinal: end, rule: 'narrator' });
        },
      };
    });
    return { unit, slots, chunks, joined: held(joinNotes(chunks)) };
  };
  // Unit i launches right after unit i - DENSE_UNIT_WINDOW is processed, before the next unit's processing starts, so its prompts see a fixed state.
  const launched: LaunchedUnit[] = [];
  const start = (index: number) => {
    if (index < units.length)
      launched[index] = launch(units[index], index >= DENSE_UNIT_WINDOW ? units[index - DENSE_UNIT_WINDOW].ordinals.at(-1)! : 0);
  };
  for (let index = 0; index < DENSE_UNIT_WINDOW; index++) start(index);

  input.onUnit?.(0, units.length);
  for (const index of units.keys()) {
    const { unit, slots: initialSlots, chunks: waiting, joined } = launched[index];
    const byId = new Map(initialSlots.map((slot) => [slot.id, slot]));
    const chunks: LaunchedChunk[] = [];
    const minorIntros = new Map<string, string>();
    const answer: PassAnswer = { notes: [], facts: [], abilities: [], ties: [], merges: [], summary: null, failed: [] };
    // A point of view never carries into the next unit, which may open on someone else.
    let lastPov: string | null = null;
    for (const launched of waiting) {
      chunks.push(launched);
      const { chunk, notes: asked, facts: told, scene: card, glosses, narratorDone } = launched;
      for (const slot of launched.slots) if (!byId.has(slot.id)) byId.set(slot.id, slot);
      const [notes, facts, scene] = await Promise.all([asked, told, card]);
      if (notes?.summary) state.summaries.push({ unit: chunk, value: notes.summary });
      for (const fact of [...glosses, ...(facts?.descriptions ?? [])]) {
        const { id } = fact.slot;
        if (state.currentAbout(id) || minorIntros.has(id)) continue;
        const intro = factsAbout([{ unit, value: fact }]);
        if (minorCharacter(fact.slot)) minorIntros.set(id, intro);
        else state.setAbout(id, unit, intro);
      }
      if (facts) {
        answer.facts.push(...facts.facts);
        answer.abilities.push(...facts.abilities);
        answer.merges.push(...facts.merges);
      }
      // A failed scene call says nothing about the point of view, so the last one stands.
      if (scene) lastPov = scene.pov ?? null;
      pov.set(chunk.id, lastPov);
      // A facts merge is one more vote on the same pairs, so it needs a second chunk and the same guards as the scene's.
      if (facts?.merges.length) input.facts.reject(same.apply(cast, chunk, facts.merges, sentences, 'merges'));
      if (scene) {
        input.ties.reject(same.apply(cast, chunk, scene.same, sentences));
        linkPairs.push(...scene.linkPairs);
        relations.record(unit, scene.ties);
      }
      await narratorDone?.(scene?.pov ?? null);
    }

    const slots = [...byId.values()];
    const names = namesFor(unit.ordinals.at(-1)!);
    answer.notes.push(...(await joined));

    // A fact already stated for the same id is not new, so it neither repeats in the timeline of facts nor triggers a rewrite of `about`.
    const known = new Map<string, Set<string>>();
    answer.facts = answer.facts.filter((fact: PassFact) => {
      const seen = known.get(fact.slot.id) ?? new Set((state.facts.get(fact.slot.id) ?? []).map((old) => factKey(old.value.text)));
      known.set(fact.slot.id, seen);
      if (seen.has(factKey(fact.text))) return false;
      seen.add(factKey(fact.text));
      return true;
    });
    const fresh = state.apply(unit, slots, answer);
    const through = unit.ordinals.at(-1)!;
    const growth = new Map<string, { outgrown: boolean; notes: readonly string[] }>();
    const grown = (slot: PassSlot, since: number) => {
      const cached = growth.get(slot.id);
      if (cached) return cached;
      const mentions = cast.mentionsOf(slot, unit);
      const before = mentions.filter((ordinal) => ordinal <= since).length;
      const exceeds = outgrown(before, mentions.length - before);
      const result = {
        outgrown: exceeds,
        notes: exceeds
          ? notesThrough(slot.id, through, since)
              .slice(-3)
              .reverse()
              .map(({ note }) => note)
          : [],
      };
      growth.set(slot.id, result);
      return result;
    };
    const writing = slots.filter((slot) => {
      if (!input.writesAbout(slot) || chunks.some(({ glosses }) => glosses.some((gloss) => gloss.slot.id === slot.id))) return false;
      if (fresh.includes(slot.id)) return true;
      const since = aboutSince(state, slot.id);
      return since !== null && grown(slot, since).outgrown;
    });
    if (writing.length)
      await writeAbout(
        writing,
        unit,
        state,
        names,
        mode,
        input.askAbout,
        input.about,
        (slot) => introducing(slot, unit, sentences, cast, isNarrator(slot)),
        isNarrator,
        grown,
        (slot) => kindFor(slot, through),
      );
    const changed = [...new Set(answer.facts.filter((fact) => fact.status).map((fact) => fact.slot.id))]
      .map((id) => byId.get(id)!)
      .filter((slot) => input.writesAbout(slot) && (mode !== 'fiction' || slot.kind === 'character'));
    await Promise.all([describeGaps(unit, slots, names, minorIntros), changed.length ? writeNow(changed, unit, state, names, input) : null]);
    start(index + DENSE_UNIT_WINDOW);
    input.onUnit?.(index + 1, units.length);
  }
  // An entry that never got an `is` phrase or a gloss falls back to its first unit's facts, stamped at that unit so it spoils nothing.
  for (const [id, slot] of state.slots) {
    if (state.currentAbout(id) || input.writesAbout(slot)) continue;
    const facts = state.factsOf(id);
    if (!facts.length) continue;
    const line = factsAbout(facts.filter((fact) => fact.unit === facts[0].unit));
    if (mode !== 'fiction' || !proseProblem(line)) state.setAbout(id, facts[0].unit, line);
  }
  const never = [...describeTries.keys()].filter((id) => !state.currentAbout(id)).length;
  if (never) input.describe.reject({ 'describe:never': never });
  cast.finishNarration();
  relations.apply(cast, state, input.ties);
  input.ties.tally('counts', { 'kin:ties': addKinTies(cast, state, units) });
  return { cast, state, merged: { pattern, model: cast.merges.length - pattern }, rewrites, required, linkPairs, pov };
}

const KIN_TIES: Record<string, { type: string; kinFirst: boolean }> = {
  mother: { type: 'parent_of', kinFirst: true },
  father: { type: 'parent_of', kinFirst: true },
  son: { type: 'parent_of', kinFirst: false },
  daughter: { type: 'parent_of', kinFirst: false },
  sister: { type: 'sibling_of', kinFirst: true },
  brother: { type: 'sibling_of', kinFirst: true },
  wife: { type: 'spouse_of', kinFirst: true },
  husband: { type: 'spouse_of', kinFirst: true },
};

const slotOf = (head: XrayEntity): PassSlot => ({ id: head.id, head, member: null, name: head.name, aliases: [], kind: head.kind, mentions: 0 });

/** "Viv's mother" is tied to Viv by code, from the unit that first names her, unless the pair already has a tie. */
export function addKinTies(cast: PassCast, state: PassState, units: readonly PassUnit[]): number {
  const byName = new Map<string, XrayEntity[]>();
  for (const named of [...cast.heads, ...cast.merges.map((merge) => merge.member)])
    for (const name of [named.name, ...named.names.map(({ text }) => text)]) byName.set(name, [...(byName.get(name) ?? []), named]);
  const tied = new Set(
    state.ties.map(({ value: { a, b, cite } }) =>
      [cast.headOf(a.member ?? a.head, cite), cast.headOf(b.member ?? b.head, cite)]
        .map((head) => head.id)
        .sort()
        .join('|'),
    ),
  );
  let added = 0;
  for (const entity of [...cast.heads, ...cast.merges.map((merge) => merge.member)]) {
    const found = /^(.+?)['’]s (\p{L}+)$/u.exec(entity.name);
    const kin = found && KIN_TIES[found[2].toLowerCase()];
    if (!found || !kin || entity.kind !== 'character') continue;
    // Both sides as they stand where the relative is first named: a later merge must not put its name on an early tie.
    const owners = [...new Set((byName.get(found[1]) ?? []).map((owner) => cast.headOf(owner, entity.first)))];
    const holder = cast.headOf(entity, entity.first);
    if (owners.length !== 1 || owners[0] === holder || owners[0].kind !== 'character') continue;
    const key = [owners[0].id, holder.id].sort().join('|');
    const unit = units.find((candidate) => candidate.ordinals.includes(entity.first));
    if (tied.has(key) || !unit) continue;
    tied.add(key);
    const [a, b] = kin.kinFirst ? [holder, owners[0]] : [owners[0], holder];
    state.slots.set(a.id, state.slots.get(a.id) ?? slotOf(a));
    state.slots.set(b.id, state.slots.get(b.id) ?? slotOf(b));
    state.addTie(unit, { a: state.slots.get(a.id)!, b: state.slots.get(b.id)!, type: kin.type, sentence: `${entity.name}.`, cite: entity.first });
    added++;
  }
  return added;
}

/**
 * Code joins before the alias ask: pairs the text names as one in at least two sentences, then lowercase epithets with a
 * single named match of their kind. Each join keeps the head's kind and is logged with its rule and sentences; pairs with
 * one sentence of evidence go on to the alias ask.
 */
function resolveIdentities(cast: PassCast, sentences: readonly Sentence[], mode: BookKnowledgeXrayMode, step: XrayStepRun): IdentityEvidence[] {
  const { merges, single } = identityMerges(cast, sentences);
  let joined = 0;
  for (const merge of merges)
    if (cast.merge({ member: merge.member, head: merge.head, ordinal: merge.ordinal, rule: 'alias', reason: `identity:${merge.reason}` })) joined++;
  let folded = 0;
  for (const fold of epithetFolds(cast, sentences, mode, single))
    if (cast.merge({ member: fold.member, head: fold.head, ordinal: fold.ordinal, rule: 'alias', reason: 'epithet-fold' })) folded++;
  step.tally('counts', { 'identity:merges': joined, 'identity:single': single.length, 'identity:epithet-folds': folded });
  return single;
}

export function readNow(raw: unknown, ids: readonly string[]): Map<string, string> | null {
  const wanted = new Set(ids);
  const found = new Map<string, string>();
  const add = (id: unknown, value: unknown) => {
    if (typeof id !== 'string' || !wanted.has(id)) return;
    const line = text(value);
    if (line) found.set(id, line);
  };
  const outer = record(raw);
  const value = outer && Object.hasOwn(outer, 'now') ? outer.now : raw;
  if (typeof value === 'string' && ids.length === 1) add(ids[0], value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      const row = record(item);
      if (row) add(row.id, text(row.now) || row.line);
    }
  } else {
    for (const [id, line] of Object.entries(record(value) ?? {})) add(id, line);
  }
  if (!found.size && outer && value !== raw) {
    for (const [id, line] of Object.entries(outer)) add(id, line);
  }
  return found.size ? found : null;
}

function nowShape(raw: unknown, ids: readonly string[]): string {
  const type = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const outer = record(raw);
  const keys = Object.keys(outer ?? {})
    .slice(0, 5)
    .map((key) => (ids.includes(key) || /^e\d+$/.test(key) ? 'id' : ['now', 'id', 'line'].includes(key) ? key : 'other'));
  return `rows=${ids.length} replyType=${type(raw)} keys=${keys.join(',') || '-'} nowType=${type(outer?.now)}`;
}

/** Status facts a `now` call shows, newest last: the current line carries what older ones said. */
const NOW_FACTS = 12;

/**
 * The main cast's `now` from its status facts, one low-effort call for the unit's changed names. A line
 * that breaks a rule is dropped and the current one kept.
 */
async function writeNow(slots: readonly PassSlot[], unit: PassUnit, state: PassState, names: LineNames, input: DenseRunInput): Promise<void> {
  const rows = slots.map((slot) => ({
    id: slot.id,
    name: slot.name,
    about: state.currentAbout(slot.id),
    now: state.currentNow(slot.id),
    facts: state
      .statusOf(slot.id)
      .slice(-NOW_FACTS)
      .map((fact) => (fact.unit === unit ? 'new: ' : '') + fact.value.text),
  }));
  const ids = rows.map(({ id }) => id);
  const user = nowUser(rows);
  const send = (user: string) => input.askWrite({ system: NOW_SYSTEM, user, maxOutputTokens: NOW_MAX_OUTPUT_TOKENS, effort: DENSE_EFFORT });
  const lines = await input.now.unit({
    id: `n${unit.id}`,
    ordinals: [],
    send: send(user),
    retryUnreadable: send(`${user}\nAnswer with JSON only, exactly {"now": {"<id>": "<line>"}} with these ids: ${ids.join(', ')}.`),
    unreadableShape: (raw) => nowShape(raw, ids),
    read: (raw) => {
      const found = readNow(raw, ids);
      return found ? { items: found, rejected: {} } : null;
    },
  });
  const rejected: Rejections = {};
  for (const [index, slot] of slots.entries()) {
    const line = lines?.get(slot.id);
    if (!line || /^(?:none|unchanged|n\/a)\W*$/i.test(line)) continue;
    const own = [slot.name, ...slot.aliases].map((name) => name.toLowerCase());
    const { about, now, facts } = rows[index];
    const support = [...facts, about ?? '', now ?? '', slot.name, ...slot.aliases, ...names.visible.map(({ text }) => text)];
    const prose = proseProblem(line);
    const reason =
      prose ??
      (NARRATOR_PHRASE.test(line)
        ? 'narrator'
        : /\b(?:you|your|yours)\b/i.test(line)
          ? 'second-person'
          : NOW_MOMENT.test(line)
            ? 'moment'
            : PROTAGONIST.test(line)
              ? 'protagonist'
              : words(line) > NOW_WORDS
                ? 'too-long'
                : /^now\b/i.test(line)
                  ? 'starts-with-now'
                  : own.some((name) => line.toLowerCase().startsWith(name))
                    ? 'starts-with-name'
                    : HEDGES.test(line)
                      ? 'hedge'
                      : namedLater(line, names).length
                        ? 'later-name'
                        : ungroundedNames(line, support).length
                          ? 'ungrounded'
                          : null);
    if (reason) add(rejected, `now:${reason}`);
    else state.setNow(slot.id, unit, line);
  }
  input.now.reject(rejected);
}

const ABOUT_EVIDENCE = 8;
const ABOUT_EVIDENCE_CHARACTERS = 220;

/** Mostly capitals: a system screen or a shout, which a model easily misreads as a description. */
const shouted = (text: string) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length > 0 && (text.match(/\p{Lu}/gu) ?? []).length > 0.6 * letters.length;
};

/**
 * The main cast's numbered sentences by the unit's end: where it is defined, first met and last seen, then the
 * sentences that say who or what it is. Front matter (a blurb, a dedication) is left out, so is an inset letter or log
 * for the narrator, and plain prose goes
 * before shouted system text. A bare label ("Intermediate 7/8") and a repeat of a line already taken are dropped.
 * Past characters, the sentence that best defines the name leads, marked.
 */
export function introducing(
  slot: PassSlot,
  unit: PassUnit,
  sentences: readonly Sentence[],
  cast: PassCast,
  narrator = slot.id === NARRATOR_ID,
): AboutEvidence[] {
  const entity = slot.member ?? slot.head;
  const names = [slot.name, ...slot.aliases];
  const concept = slot.kind !== 'character';
  const lines = new Set<string>();
  // A head's merged ordinals hold its members' sentences from before their joins; the cast's mentions do not.
  const seen = cast.mentionsOf(slot, unit).filter((ordinal) => {
    const { text, inset } = sentences[ordinal - 1];
    if ((narrator && inset) || bareLabel(text, names) || lines.has(sameText(text))) return false;
    lines.add(sameText(text));
    return true;
  });
  const body = seen.filter((ordinal) => sentences[ordinal - 1].structure !== 'front');
  const plain = body.filter((ordinal) => !shouted(sentences[ordinal - 1].text));
  const pool = plain.length ? plain : body.length ? body : seen;
  const definition = concept ? definitionOf(body, sentences, names) : null;
  // A system line about something else ("[Skill gained: ...]") passes the bracket branch, so concepts are sampled from prose identity only.
  const identifies = concept ? IDENTITY_PROSE : IDENTITY;
  const defining = pool.filter((ordinal) => entity.defining.has(ordinal));
  const identity = pool.filter((ordinal) => !entity.defining.has(ordinal) && identifies.test(sentences[ordinal - 1].text));
  const shown = (ordinal: number) => sentences[ordinal - 1].text.replace(/\s+/g, ' ').trim().slice(0, ABOUT_EVIDENCE_CHARACTERS);
  const rest = [...new Set([defining[0], pool[0], pool.at(-1), ...defining.slice(1), ...spread(identity, ABOUT_EVIDENCE), pool.at(-2)])]
    .filter((ordinal): ordinal is number => ordinal !== undefined && ordinal !== definition)
    .slice(0, definition === null ? ABOUT_EVIDENCE : ABOUT_EVIDENCE - 1)
    .sort((a, b) => a - b)
    .map((ordinal): AboutEvidence => ({ ordinal, text: shown(ordinal), ...(sentences[ordinal - 1].inset ? { written: true as const } : {}) }));
  if (definition === null) return rest;
  return [
    { ordinal: definition, text: shown(definition), definition: true, ...(sentences[definition - 1].inset ? { written: true as const } : {}) },
    ...rest,
  ];
}

/** Up to `count` of `ordinals`, evenly spaced, so a long-running name is not described from one chapter. */
function spread(ordinals: readonly number[], count: number): number[] {
  if (ordinals.length <= count) return [...ordinals];
  return Array.from({ length: count }, (_, index) => ordinals[Math.floor((index * ordinals.length) / count)]);
}
