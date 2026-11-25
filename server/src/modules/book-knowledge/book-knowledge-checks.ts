import { BadGatewayException } from '@nestjs/common';
import type { BookKnowledgeCard, BookKnowledgeAnswer, BookKnowledgeChecks, BookKnowledgePassage, BookKnowledgePoint } from '@bookorbit/types';
import { ungroundedNames } from './xray/pass/pass-grounding';
export const normalizeQuote = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
export function quoteVerified(quote: string, passage: BookKnowledgePassage | undefined): boolean {
  return !!passage && !!quote.trim() && normalizeQuote(passage.text).includes(normalizeQuote(quote));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadGatewayException('Invalid model response');
  return value as Record<string, unknown>;
}
const quoteWords = (text: string): string[] => normalizeQuote(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const functionWords = new Set(
  'a an the it its they their them he she his her is are was were be been being to of in on at for from with as and or but that this these those by has have had does do did not only can could may might would should what which who how'.split(
    ' ',
  ),
);
function supportsPoint(text: string, quote: string, aliases: string[]): boolean {
  const words = quoteWords(quote);
  if (words.length < 4) return false;
  const excluded = new Set(aliases.flatMap(quoteWords));
  const content = (word: string) => !functionWords.has(word) && !excluded.has(word);
  const claim = new Set(quoteWords(text).filter(content));
  return words.some((word) => content(word) && claim.has(word));
}
function points(value: unknown, passages: BookKnowledgePassage[], aliases: string[], support: string[]) {
  if (!Array.isArray(value) || value.length > 4) throw new BadGatewayException('Invalid model points');
  let unknownPassage = false;
  const kept: BookKnowledgePoint[] = [];
  const texts = new Set<string>();
  const quotes = new Set<string>();
  for (const raw of value) {
    const p = object(raw);
    if (typeof p.text !== 'string' || typeof p.quote !== 'string' || !Number.isInteger(p.passage) || p.text.length > 4000 || p.quote.length > 10000)
      throw new BadGatewayException('Invalid model point');
    const passage = passages.find((v) => v.number === p.passage);
    if (!passage) unknownPassage = true;
    const text = normalizeQuote(p.text);
    const quote = normalizeQuote(p.quote);
    if (
      quoteVerified(p.quote, passage) &&
      supportsPoint(p.text, p.quote, aliases) &&
      ungroundedNames(p.text, support).length === 0 &&
      !texts.has(text) &&
      !quotes.has(quote)
    ) {
      kept.push({ text: p.text, quote: p.quote, passage: p.passage as number });
      texts.add(text);
      quotes.add(quote);
    }
  }
  return { kept, unknownPassage, droppedPoints: value.length - kept.length };
}
export function checkCard(
  raw: unknown,
  passages: BookKnowledgePassage[],
  aliases: string[] = [],
): { card: BookKnowledgeCard; checks: BookKnowledgeChecks } {
  const value = object(raw);
  if (
    typeof value.meaning !== 'string' ||
    value.meaning.length > 4000 ||
    typeof value.meaningQuote !== 'string' ||
    !Number.isInteger(value.meaningPassage) ||
    typeof value.insufficient !== 'boolean'
  )
    throw new BadGatewayException('Invalid model card');
  const support = [...passages.map((p) => p.text), ...aliases];
  const checked = points(value.points, passages, aliases, support);
  const passage = passages.find((p) => p.number === value.meaningPassage);
  const meaningVerified = quoteVerified(value.meaningQuote, passage) && ungroundedNames(value.meaning, support).length === 0;
  return {
    card: {
      meaning: meaningVerified ? value.meaning : '',
      meaningQuote: meaningVerified ? value.meaningQuote : '',
      meaningPassage: meaningVerified ? (value.meaningPassage as number) : 0,
      points: checked.kept,
      insufficient: value.insufficient || !meaningVerified,
    },
    checks: { meaningVerified, droppedPoints: checked.droppedPoints, unknownPassage: checked.unknownPassage || !passage },
  };
}
export function checkAnswer(
  raw: unknown,
  passages: BookKnowledgePassage[],
  aliases: string[] = [],
): { answer: BookKnowledgeAnswer; checks: BookKnowledgeChecks } {
  const value = object(raw);
  if (typeof value.answer !== 'string' || value.answer.length > 6000 || typeof value.notInBook !== 'boolean')
    throw new BadGatewayException('Invalid model answer');
  const support = [...passages.map((p) => p.text), ...aliases];
  const checked = points(value.points, passages, aliases, support);
  const verified = !value.notInBook && checked.kept.length > 0;
  const answerGrounded = ungroundedNames(value.answer, support).length === 0;
  return {
    answer: {
      answer: verified
        ? answerGrounded && checked.kept.length >= checked.droppedPoints
          ? value.answer
          : checked.kept.map((point) => point.text).join(' ')
        : 'Insufficient verified evidence in the passages read.',
      points: value.notInBook ? [] : checked.kept,
      notInBook: value.notInBook || !verified,
    },
    checks: {
      meaningVerified: verified && answerGrounded && checked.droppedPoints === 0,
      droppedPoints: checked.droppedPoints,
      unknownPassage: checked.unknownPassage,
    },
  };
}
export function evidenceFloor(passages: BookKnowledgePassage[], hasDefinition: boolean): boolean {
  return passages.length < 2 && !hasDefinition;
}
