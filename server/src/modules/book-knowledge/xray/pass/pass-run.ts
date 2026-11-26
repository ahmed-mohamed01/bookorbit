import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import {
  lineProblem,
  linesRequest,
  linesRewriteRequest,
  LINES_MAX_OUTPUT_TOKENS,
  namedLater,
  readLinesAnswer,
  type LineNames,
  type LinesRow,
} from '../../../story-guides/pipeline/lines-step';
import { escapeRegExp, nameKey, splitWords, WORD_CHAR, WORD_EDGE } from '../../../story-guides/pipeline/name-text';
import type { AiEffort, AiResult } from '../../../ai/ai-client.types';
import type { Rejections } from '../xray-checks';
import type { XrayEntity } from '../xray-entities';
import type { XrayStepRun } from '../xray-runner';
import { unattributedModal } from '../xray-description-context';
import { descriptionTokens, DESCRIPTION_TIERS, slotTier, tierShape, type DescriptionTier } from '../xray-tiers';
import { fictionAboutSystem } from './pass-about-prompt';
import { NARRATOR_ID, type PassCast, type PassSlot } from './pass-cast';
import { NARRATOR_PHRASE, record, SELF_LABEL } from './pass-read';
import { ungroundedNames } from './pass-grounding';
import type { PassState } from './pass-state';
import type { PassUnit } from './pass-units';

const HEDGES = /\b(?:possibly|perhaps|likely|may be|seems?|seemingly|apparently)\b/i;
const FICTION_LINE_PHRASES = new RegExp(`${WORD_EDGE}or${WORD_EDGE}`, 'iu');

const nonfictionAboutSystem = (tier: DescriptionTier) =>
  'Below are terms and names of a nonfiction book that the chapter just read says something lasting about. Each has its current ' +
  'description ("none" when new) and the facts stated so far; facts from the chapter just read start with "new:".\n' +
  `A description says what the author means by a term, whose view it is (the author's own or someone the book cites) and how the book uses it so far, or, for a person, who they are and what the book cites them for, in ${tierShape(tier)}, built only from the facts.\n` +
  'Keep the current description exactly as it is unless the new facts add to it or show it is wrong. Never hedge, never guess, and never ' +
  'add anything the facts do not say, even if you know the book or its subject. Use the names exactly as given.\n' +
  'Answer with JSON only: {"lines": {"<name>": "<description>"}}';

/** `capped`: `maxOutputTokens` is a hard cap, never doubled after a cut-short reply. */
export type Ask = (request: {
  system: string;
  user: string;
  maxOutputTokens: number;
  effort?: AiEffort;
  capped?: boolean;
  temperature?: number;
}) => () => Promise<AiResult>;

export interface PassRunResult {
  cast: PassCast;
  state: PassState;
  /** The pattern merges made before the pass, then the model's accepted ones. */
  merged: { pattern: number; model: number };
  rewrites: number;
}

export function cloned(entities: readonly XrayEntity[]): XrayEntity[] {
  return entities.map((entity) => ({ ...entity, ordinals: [...entity.ordinals], names: [...entity.names], joins: [...entity.joins] }));
}

/** A numbered sentence shown to the main cast's `about`, so the line can cite what it rests on. */
export interface AboutEvidence {
  ordinal: number;
  text: string;
  /** The sentence that defines a non-character entry, shown first and labelled so the line agrees with it. */
  definition?: true;
}

/** Main-cast rows a call: few enough that a medium-effort answer is not cut short. */
const ABOUT_BATCH = 4;
/**
 * The leads get medium effort: at low effort their lines went wrong twice as often, a lead given another
 * character's identity. The rest of the main cast reads as well at low, for a fifth of the output.
 */
const leadEffort = (lead: boolean) => (lead ? ('medium' as const) : ('low' as const));
/** The newest facts shown, so the line is built from who someone is rather than a list of everything. */
const ABOUT_FACTS = 8;
/** Reasoning room an about call keeps on top of its lines, so a medium-effort answer is not cut short. */
const ABOUT_REASONING_TOKENS = 6000;
const aboutOutputTokens = (rows: number, tier: DescriptionTier, floor: number) =>
  Math.max(floor, ABOUT_REASONING_TOKENS + rows * descriptionTokens(tier));

const IDENTITY_CUE_WORDS =
  /\b(?:roles?|ranks?|titles?|classes?|allegiance|family|bonds?|captain|lieutenant|corporal|sergeant|general|commander|king|queen|princess?|prince|lord|lady|heir|duke|duchess|knight|priest(?:ess)?|witch|medic|student|teacher|brother|sister|mother|father|son|daughter|wife|husband|spouse|parent|sibling|partner|mentor|apprentice|pledged|sworn|defected|promoted|demoted|serves?)\b/gi;
const IDENTITY_CUE = new RegExp(`^${IDENTITY_CUE_WORDS.source}$`, 'i');
const RELATION = /\b(?:ally|allies|enemy|enemies|friend|rival|married|adopted|betrothed|loyal|related|follows?|betrayed|bonded)\b/i;

/** "sisters" and "sister", "princesses" and "princess": one word for whether a line already says it. */
const stem = (word: string) => word.toLowerCase().replace(/(?<=[sx]|ch|sh)es$|(?<!s)s$/, '');
const letterWords = (text: string) => text.match(/\p{L}+/gu) ?? [];

/**
 * Whether a new fact changes who someone is, so their frozen `about` is sent again: a role, kin or rank cue the line does
 * not already say, a denial of a cue word or cast name the line does say, or a relation to someone the line does not name.
 */
export function changesIdentity(fact: string, current: string, cast: readonly string[]): boolean {
  const said = new Set(letterWords(current).map(stem));
  if ((fact.match(IDENTITY_CUE_WORDS) ?? []).some((cue) => !said.has(stem(cue)))) return true;
  const named = (name: string, text: string) => new RegExp(`${WORD_EDGE}${escapeRegExp(name)}${WORD_EDGE}`, 'iu').test(text);
  if (/\b(?:not|never|no longer)\b/i.test(fact)) {
    if (letterWords(fact).some((word) => said.has(stem(word)) && IDENTITY_CUE.test(word))) return true;
    if (cast.some((name) => named(name, fact) && named(name, current))) return true;
  }
  return (
    RELATION.test(fact) &&
    cast.some((name) => {
      const mention = new RegExp(`${WORD_EDGE}${escapeRegExp(name)}${WORD_EDGE}`, 'iu');
      return mention.test(fact) && !mention.test(current);
    })
  );
}

/**
 * The main cast's `about` from its facts and the sentences that show it: each row has its current line,
 * its newest facts (new ones marked) and numbered sentences, and a line that breaks a rule gets one rewrite
 * before the old one is kept.
 */
export async function writeAbout(
  slots: readonly PassSlot[],
  unit: PassUnit,
  state: PassState,
  names: LineNames,
  mode: BookKnowledgeXrayMode,
  ask: Ask,
  step: XrayStepRun,
  evidence: (slot: PassSlot) => readonly AboutEvidence[] = () => [],
): Promise<void> {
  const castNames = names.visible.map((name) => name.text);
  const eligible = slots.filter((slot) => {
    const current = state.currentAbout(slot.id);
    return !current || state.factsOf(slot.id).some((fact) => fact.unit === unit && changesIdentity(fact.value.text, current, castNames));
  });
  if (eligible.length !== slots.length) step.tally('counts', { 'about:frozen': slots.length - eligible.length });
  slots = eligible;
  const fiction = mode === 'fiction';
  const shown = new Map(slots.map((slot, index) => [index, evidence(slot)]));
  // A defined concept's facts are scene details that pull the line away from what the definition says it is.
  const defined = (index: number) => fiction && slots[index].kind !== 'character' && shown.get(index)!.some((sentence) => sentence.definition);
  const rows: LinesRow[] = slots.map((slot, index) => ({
    entity: index,
    name: slot.name,
    current: state.currentAbout(slot.id),
    notes: defined(index)
      ? []
      : state
          .factsOf(slot.id)
          .slice(-ABOUT_FACTS)
          .map((fact) => (fact.unit === unit ? 'new: ' : '') + fact.value.text),
  }));
  const noNames: LineNames = { later: [], visible: [] };
  const tierOf = (row: LinesRow) => slotTier(slots[row.entity], mode);
  const problem = (row: LinesRow, { line, cites }: AboutLine) => {
    const narrator = slots[row.entity].id === NARRATOR_ID;
    if (!narrator && NARRATOR_PHRASE.test(line)) return 'says "the narrator" instead of a name';
    const limit = tierOf(row).limit;
    if (fiction && line.toLowerCase() === 'unchanged') return null;
    if (HEDGES.test(line)) return 'hedges ("possibly", "perhaps", "seems")';
    if (fiction) {
      if (unattributedModal(line)) return 'uses would or could without attributing it to a thinker';
      const slot = slots[row.entity];
      if (
        !(narrator && /^the narrator\b/i.test(line)) &&
        [slot.name, ...slot.aliases].some((name) => new RegExp(`^(?:the\\s+)?${escapeRegExp(name)}(?!${WORD_CHAR})`, 'iu').test(line))
      )
        return 'starts with its own name';
      if (SELF_LABEL.test(line)) return 'opens with a label ("An idea describing", "A character named") instead of saying what it is';
      const given = new Set(shown.get(row.entity)!.map((sentence) => sentence.ordinal));
      if (given.size && (!cites.length || cites.some((cite) => !given.has(cite))))
        return 'n must list the numbers of the given sentences the line rests on';
      const upstream = lineProblem(line, names);
      if (upstream && upstream.reason !== 'too-long' && !(narrator && upstream.reason === 'narrator')) return upstream.detail;
      if (upstream?.reason === 'too-long') {
        if (splitWords(line).length > limit) return `is longer than ${limit} words`;
        // The upstream word limit runs before its hedge check.
        const phrase = line.match(FICTION_LINE_PHRASES)?.[0];
        const narrated = phrase ? lineProblem(phrase, noNames)?.detail : undefined;
        if (narrated) return narrated;
      }
      return null;
    }
    const later = namedLater(line, names);
    if (later.length) return `names ${later.join(', ')}, who the facts have not introduced yet`;
    return splitWords(line).length > limit ? `is longer than ${limit} words` : null;
  };
  // A name the row was not shown is dropped rather than rewritten: asked again, the model swapped one stray name for another.
  const ungrounded = (row: LinesRow, line: string) => {
    if (!fiction || !shown.get(row.entity)!.length) return false;
    const slot = slots[row.entity];
    return ungroundedNames(line, [...shown.get(row.entity)!.map((sentence) => sentence.text), ...row.notes, slot.name, ...slot.aliases]).length > 0;
  };
  const key = (row: LinesRow) => (fiction ? slots[row.entity].id : nameKey(row.name));
  type Failed = { row: LinesRow; line: string; detail: string };
  // A batch holds one tier, so its prompt carries one limit.
  const request = (batch: readonly LinesRow[], rewrite: Failed[] | null) => {
    const tier = tierOf(batch[0]);
    if (fiction) {
      const user = (rewrite ? rewrite.map(({ row }) => row) : batch)
        .map((row) =>
          [
            `${key(row)} | ${row.name} | current: ${row.current ?? 'none'} | facts: ${row.notes.join('; ') || 'none'}`,
            ...shown.get(row.entity)!.map(({ ordinal, text, definition }) => `  ${definition ? 'definition ' : ''}[${ordinal}] ${text}`),
          ].join('\n'),
        )
        .join('\n\n');
      const retry = rewrite
        ? '\n\nThese lines broke a rule. Write each again, following every rule above:\n' +
          rewrite.map(({ row, line, detail }) => `- ${key(row)}: "${line}" (${detail})`).join('\n')
        : '';
      return {
        system: fictionAboutSystem(tier),
        user: user + retry,
        maxOutputTokens: aboutOutputTokens(batch.length, tier, LINES_MAX_OUTPUT_TOKENS),
        effort: leadEffort(tier.name === 'main'),
      };
    }
    const upstream = rewrite ? linesRewriteRequest(batch, rewrite) : linesRequest(batch);
    return {
      system: nonfictionAboutSystem(tier),
      user: upstream.user,
      maxOutputTokens: aboutOutputTokens(batch.length, tier, upstream.maxOutputTokens ?? LINES_MAX_OUTPUT_TOKENS),
      effort: upstream.effort,
    };
  };
  const send = async (id: string, batch: readonly LinesRow[], rewrite: Failed[] | null) =>
    step.unit({
      id,
      ordinals: [],
      // gpt-oss loops at temperature 0, so the about ask keeps the default sampling.
      send: ask(request(batch, rewrite)),
      read: (answer) => {
        const found = record(answer);
        if (!found) return null;
        const lines = fiction ? fictionLines(found) : readLinesAnswer(found);
        return lines
          ? { items: new Map([...lines].map(([id, line]) => [id, typeof line === 'string' ? { line, cites: [] } : line])), rejected: {} }
          : null;
      },
    });
  const accept = (row: LinesRow, line: string) => {
    if (fiction && line.toLowerCase() === 'unchanged') step.tally('counts', { 'about:unchanged': 1 });
    else state.setAbout(slots[row.entity].id, unit, line);
  };
  const batches: LinesRow[][] = [];
  const size = fiction ? ABOUT_BATCH : rows.length;
  // Each tier batches apart, so only the leads' calls pay for medium effort and each prompt states one length.
  for (const tier of DESCRIPTION_TIERS) {
    const group = rows.filter((row) => tierOf(row) === tier);
    for (let at = 0; at < group.length; at += size) batches.push(group.slice(at, at + size));
  }
  await Promise.all(
    batches.map(async (batch, index) => {
      const id = batches.length > 1 ? `a${unit.id}.${index + 1}` : `a${unit.id}`;
      const first = (await send(id, batch, null)) ?? new Map<string, AboutLine>();
      const failed: Failed[] = [];
      for (const row of batch) {
        const found = first.get(key(row));
        const line = found?.line.trim();
        if (!line) continue;
        const detail = problem(row, { line, cites: found!.cites });
        if (detail) failed.push({ row, line, detail });
        else if (ungrounded(row, line)) step.tally('counts', { 'about:ungrounded': 1 });
        else accept(row, line);
      }
      if (!failed.length) return;
      const again = (await send(`${id}r`, batch, failed)) ?? new Map<string, AboutLine>();
      const dropped: Rejections = {};
      for (const item of failed) {
        const found = again.get(key(item.row));
        const line = found?.line.trim();
        if (line && !problem(item.row, { line, cites: found!.cites }) && !ungrounded(item.row, line)) accept(item.row, line);
        else dropped['about:rewrite-failed'] = (dropped['about:rewrite-failed'] ?? 0) + 1;
      }
      step.reject(dropped);
    }),
  );
}

interface AboutLine {
  line: string;
  cites: number[];
}

/** `{"e1": {"about": "...", "n": [12]}, "e2": "unchanged"}`: a bare string is taken as the line with no cites. */
function fictionLines(found: Record<string, unknown>): Map<string, AboutLine> {
  const lines = new Map<string, AboutLine>();
  for (const [id, value] of Object.entries(found)) {
    if (typeof value === 'string') lines.set(id, { line: value, cites: [] });
    const item = record(value);
    if (item && typeof item.about === 'string')
      lines.set(id, { line: item.about, cites: Array.isArray(item.n) ? item.n.filter((cite): cite is number => Number.isInteger(cite)) : [] });
  }
  return lines;
}
