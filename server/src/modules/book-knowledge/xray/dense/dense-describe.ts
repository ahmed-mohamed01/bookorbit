import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { escapeRegExp, splitWords, WORD_CHAR } from '../../../story-guides/pipeline/name-text';
import { lineProblem, namedLater, type LineNames } from '../../../story-guides/pipeline/lines-step';
import type { Sentence } from '../../core/model';
import { wordRarity } from '../../core/common-words';
import { retrievalStem, retrievalTokens } from '../../core/text-utils';
import {
  DESCRIPTION_PROSE,
  KIND_CONTENT,
  LASTING_ONLY,
  proseProblem,
  THOUGHT_DESCRIPTION,
  unattributedModal,
  WRITTEN_TEXT_RULE,
  WRITTEN_VOICE_RULE,
} from '../xray-description-context';
import type { Rejections } from '../xray-checks';
import type { XrayStepRun } from '../xray-runner';
import { NARRATOR_ID, type PassSlot } from '../pass/pass-cast';
import { descriptionTokens, DESCRIPTION_TIERS, MAIN_TIER, MINOR_TIER, slotTier, tierShape, type DescriptionTier } from '../xray-tiers';
import { EMPTY_FACT, HEDGES, NARRATOR_PHRASE, record, SELF_LABEL, text, words } from '../pass/pass-read';
import type { Ask } from '../pass/pass-run';
import { EXACT_TERM_NAMES, garbledTerm, ungroundedNames } from '../pass/pass-grounding';
import { citesIn } from './dense-chunks';
import { bareLabel } from './dense-definition';

/** Entities a description call. */
export const DESCRIBE_BATCH = 15;
export const DESCRIBE_SENTENCES = 8;
/** Low-effort reasoning room a describe call keeps on top of its lines: 15 one-line answers fit in 2,500 tokens. */
const DESCRIBE_REASONING_TOKENS = 1600;
export const describeOutputTokens = (entries: number, tier: DescriptionTier) => DESCRIBE_REASONING_TOKENS + entries * descriptionTokens(tier);

/** Identity wording in prose, without the system-line branch that matches every bracketed or slashed line. */
export const IDENTITY_PROSE =
  /\b(is|was|were|are)\s+(a|an|the|one of|her|his|their)\b|\bnamed\b|\bcalled\b|\bknown as\b|\b(brother|sister|mother|father|son|daughter|wife|husband|captain|lieutenant|corporal|sergeant|king|queen|princess|prince|lord|lady|goddess|god|priestess|witch|golem|dragon|city|capital|village|fort|world|empire)\b/i;
export const IDENTITY = new RegExp(`${IDENTITY_PROSE.source}|^\\s*[[/]`, 'i');
const KIND_LEAD = /^(?:(?:a|an|the) )?(?:(?:object|idea|concept|character|item|place)(?:\s*[,:]\s*| of )|term for )/i;
const META = /\b(is |was )?(only |briefly )?(mentioned|referenced|discussed)\b/i;
export const PROTAGONIST = /\bthe (?:[\p{L}'’-]+\s+)?(?:protagonist|main character)\b/iu;

export function clean(line: string, names: readonly string[]): string {
  const stripped = text(line.replace(/\s*(?:\(n\d+(?:\s*,\s*n\d+)*\)|\[\d+\])/gi, ''));
  let rest = stripped;
  if (names.length) {
    const own = [...names]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    const lead = new RegExp(
      `^(?:(?:(?:a|an|the)\\s+)?(?:${own})(?:e?s)?(?:\\s+[\\p{L}-]+)?(?:\\s*\\([^)]{1,40}\\))?\\s+(?:is|was|are|were|refers\\s+to|means|denotes|describes|stands\\s+for)\\b|(?:${own})(?:[,:]|\\s+-))\\s*`,
      'iu',
    );
    rest = rest.replace(lead, '');
  }
  rest = rest.replace(KIND_LEAD, '');
  return rest === stripped ? rest : rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function startsWithOwnName(line: string, own: readonly string[]): boolean {
  return own.some((name) => new RegExp(`^(?:(?:the|a|an)\\s+)?${escapeRegExp(name)}(?!${WORD_CHAR})`, 'iu').test(line));
}

export function descriptionProblem(
  line: string,
  names: LineNames,
  own: readonly string[],
  limit: number,
  narrator = false,
  fiction = true,
): string | null {
  if (!line || EMPTY_FACT.test(line)) return 'empty';
  const prose = fiction ? proseProblem(line) : null;
  if (prose) return prose;
  if (META.test(line) || PROTAGONIST.test(line) || SELF_LABEL.test(line)) return 'label';
  if (!(narrator && /^the narrator\b/i.test(line)) && startsWithOwnName(line, own)) return 'starts-with-name';
  if (HEDGES.test(line) || /\bor\b/i.test(line)) return 'hedged';
  if (fiction && unattributedModal(line)) return 'unattributed-modal';
  if (!narrator && NARRATOR_PHRASE.test(line)) return 'narrator';
  if (splitWords(line).length > limit) return 'too-long';
  const problem = lineProblem(line, names);
  return problem && problem.reason !== 'too-long' && !(narrator && problem.reason === 'narrator') ? problem.reason : null;
}

export function contextNamesOthers(context: string, mention: string, own: readonly string[]): boolean {
  const known = new Set([mention, ...own].flatMap(retrievalTokens));
  return (context.match(/(?<!\p{L})\p{Lu}\p{L}{3,}/gu) ?? []).some((word) => {
    const lower = word.toLowerCase();
    return wordRarity(lower) === 1 && !known.has(retrievalStem(lower));
  });
}

export function descriptionEvidence(
  mentions: readonly number[],
  sentences: readonly Sentence[],
  own: readonly string[] = [],
  narrator = false,
): { mentions: number[]; context: number[] } {
  const usable = narrator ? mentions.filter((ordinal) => !sentences[ordinal - 1].inset) : mentions;
  const substantive = own.length ? usable.filter((ordinal) => !bareLabel(sentences[ordinal - 1].text, own)) : usable;
  const identity: number[] = [];
  const other: number[] = [];
  for (const ordinal of substantive.length ? substantive : usable.slice(0, 1))
    (IDENTITY.test(sentences[ordinal - 1].text) ? identity : other).push(ordinal);
  const selected = [...identity, ...other].slice(0, DESCRIBE_SENTENCES).sort((a, b) => a - b);
  const named = new Set(mentions);
  const context = selected.slice(0, 2).flatMap((ordinal) => {
    const before = ordinal - 1;
    return before > 0 &&
      !named.has(before) &&
      !(narrator && sentences[before - 1].inset) &&
      (!own.length || !contextNamesOthers(sentences[before - 1].text, sentences[ordinal - 1].text, own))
      ? [before]
      : [];
  });
  return { mentions: selected, context };
}

export function sharedLines(lines: ReadonlyMap<string, string>): Set<string> {
  const first = new Map<string, string>();
  const shared = new Set<string>();
  for (const [id, line] of lines) {
    const folded = line.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const other = first.get(folded);
    if (other === undefined) first.set(folded, id);
    else {
      shared.add(other);
      shared.add(id);
    }
  }
  return shared;
}

/** What a longer line adds once it has said what the entry is. */
function describeMore(tier: DescriptionTier): string {
  if (tier === MINOR_TIER) return '';
  return tier === MAIN_TIER
    ? 'Then only what the reader needs of their situation, key relationships and what drives them so far, as the sentences show. '
    : 'Then the one or two things that matter most about them, as the sentences show. ';
}

const CONTEXT_RULE =
  'A line marked context only helps you read the line after it: never take a claim from it. Sentences often talk about ' +
  'other people too: describe only the entry named, never someone else in the same sentence. When one sentence names ' +
  'several entries, give each only what is said of it. ' +
  WRITTEN_VOICE_RULE +
  WRITTEN_TEXT_RULE;

export function describeSystem(mode: BookKnowledgeXrayMode, tier: DescriptionTier): string {
  if (mode === 'nonfiction')
    return (
      'Below are terms and names from a nonfiction book, each with the first sentences that use it, numbered. For each, write ' +
      `${tierShape(tier, mode)}. Say what the term means here or who the person is and why the book cites them, from those ` +
      'sentences only. Never use what you know of the subject from elsewhere, never guess or hedge. Do not start with the name. ' +
      CONTEXT_RULE +
      'n: the ' +
      'numbers of the one to three sentences it rests on.\n' +
      'Answer with JSON only: {"e1": {"about": "...", "n": [1234]}}, one key for every name.'
    );
  const minorEvidence =
    tier === MINOR_TIER
      ? 'When an entry has accepted timeline notes, read them first and use the sampled sentences to supplement them. For a minor character, base the short description on what they did that matters most. '
      : '';
  return (
    `For each name, use only the supplied evidence. Write ${tierShape(tier, mode)}. ${DESCRIPTION_PROSE} ` +
    'Say who or what it is as of this point: what kind of person, creature, place, group, item, skill or idea it is, its role, and how it relates to the main characters when the sentences say so. ' +
    describeMore(tier) +
    minorEvidence +
    `${KIND_CONTENT} ${LASTING_ONLY} ` +
    THOUGHT_DESCRIPTION +
    ' Use two short sentences if needed to give the relation and attribute the thought. Do not start with the name or another name for it. Mention nothing later. ' +
    'Never start with the kind word (object, idea, concept, character, item, place) and never say the name is mentioned, referenced or discussed. ' +
    'Name other characters by name, never "the protagonist". ' +
    'Someone only passing through gets a short line. If the sentences say nothing beyond the bare name, give null. ' +
    CONTEXT_RULE +
    EXACT_TERM_NAMES +
    'n: the numbers of the one to three evidence lines it rests on. Never use what you know of the book from elsewhere, never guess or hedge.\n' +
    'Answer with JSON only: {"e1": {"about": "...", "n": [1234]}}, one key for every name.'
  );
}

/**
 * One line each for entries the facts ask left without one (no `is`, or a rejected one) and no gloss covers, in batches
 * of `DESCRIBE_BATCH` within one tier, from their first identity sentences. A line that breaks a rule is dropped, so the entry is tried again later.
 */
export async function describeEntities(
  slots: readonly { slot: PassSlot; mentions: readonly number[]; notes?: readonly { note: string; at: number }[] }[],
  unitId: string,
  names: LineNames,
  sentences: readonly Sentence[],
  mode: BookKnowledgeXrayMode,
  ask: Ask,
  step: XrayStepRun,
  isNarrator: (slot: PassSlot) => boolean = (slot) => slot.id === NARRATOR_ID,
  kindOf: (slot: PassSlot) => string = (slot) => slot.kind,
): Promise<Map<string, string>> {
  const batches: (typeof slots)[] = [];
  for (const tier of DESCRIPTION_TIERS) {
    const group = slots.filter(({ slot }) => slotTier(slot, mode) === tier);
    for (let at = 0; at < group.length; at += DESCRIBE_BATCH) batches.push(group.slice(at, at + DESCRIBE_BATCH));
  }
  const lines = new Map<string, string>();
  const rejected: Rejections = {};
  const drop = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  await Promise.all(
    batches.map(async (batch, index) => {
      const tier = slotTier(batch[0].slot, mode);
      const shown = batch.map(({ slot, mentions, notes = [] }) => {
        const own = [slot.name, ...slot.aliases];
        return { slot, notes, own, ...descriptionEvidence(mentions, sentences, own, isNarrator(slot)) };
      });
      const user = shown
        .map(({ slot, mentions, context, notes }) =>
          [
            `${slot.id} | ${slot.name}${slot.aliases.length ? ` (also ${slot.aliases.join(', ')})` : ''} | ${kindOf(slot)}`,
            ...notes.map(({ at, note }) => `  Timeline note [${at}] ${note}`),
            ...[...mentions, ...context]
              .sort((a, b) => a - b)
              .map(
                (ordinal) =>
                  `  ${context.includes(ordinal) ? 'context ' : ''}${sentences[ordinal - 1].inset ? 'written ' : ''}[${ordinal}] ${sentences[ordinal - 1].text.replace(/\s+/g, ' ').trim()}`,
              ),
          ].join('\n'),
        )
        .join('\n\n');
      const answer = await step.unit({
        id: `d${unitId}.${index + 1}`,
        ordinals: shown.flatMap(({ mentions, context, notes }) => [...mentions, ...context, ...notes.map(({ at }) => at)]),
        send: ask({
          system: describeSystem(mode, tier),
          user,
          maxOutputTokens: describeOutputTokens(batch.length, tier),
          effort: 'low',
          capped: true,
        }),
        tries: 1,
        read: (raw) => {
          const found = record(raw);
          return found ? { items: found, rejected: {} } : null;
        },
      });
      for (const { slot, mentions, notes, own } of shown) {
        const item = record(answer?.[slot.id]);
        const support = [...notes.map(({ note }) => note), ...mentions.map((ordinal) => sentences[ordinal - 1].text)];
        const raw = text(item?.about);
        const line = clean(raw, own);
        const prose = mode === 'fiction' ? proseProblem(line) : null;
        if (!raw) drop('describe:missing');
        else if (!line) drop('describe:empty');
        else if (prose) drop(`describe:${prose}`);
        else if (META.test(line)) drop('describe:meta');
        else if (mode === 'fiction' && SELF_LABEL.test(line)) drop('describe:label');
        else if (!isNarrator(slot) && NARRATOR_PHRASE.test(line)) drop('describe:narrator');
        else if (PROTAGONIST.test(line)) drop('describe:protagonist');
        else if (words(line) > tier.limit) drop('describe:too-long');
        else if (EMPTY_FACT.test(line)) drop('describe:empty');
        else if (HEDGES.test(line)) drop('describe:hedge');
        else if (mode === 'fiction' && unattributedModal(line)) drop('describe:unattributed-modal');
        else if (!(isNarrator(slot) && /^the narrator\b/i.test(line)) && startsWithOwnName(line, own)) drop('describe:starts-with-name');
        else if (namedLater(line, names).length) drop('describe:later-name');
        else if (mode === 'fiction' && ungroundedNames(line, [...support, ...own, ...names.visible.map(({ text }) => text)]).length)
          drop('describe:ungrounded');
        else if (mode === 'fiction' && garbledTerm(line, support, own)) drop('describe:garbled-term');
        else if (!citesIn(item?.n, new Set([...mentions, ...notes.map(({ at }) => at)])).cites.length) drop('describe:no-cite');
        else lines.set(slot.id, line);
      }
    }),
  );
  step.reject(rejected);
  return lines;
}
