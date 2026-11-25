import type { Sentence, VisibleTerm } from './model';
import { termKey } from './text-utils';

const nameWord = String.raw`\p{Lu}[\p{L}\p{M}\p{N}]*(?:[-’'][\p{L}\p{M}\p{N}]+)*`;
const name = String.raw`${nameWord}(?:\s+${nameWord})*`;
const verb = String.raw`(?:said|says|ask(?:ed|s)|repl(?:ied|ies)|whisper(?:ed|s)|call(?:ed|s)|shout(?:ed|s)|mutter(?:ed|s)|answer(?:ed|s)|add(?:ed|s)|snapped|snaps|not(?:ed|es)|told|tells|continu(?:ed|es))`;
const leading = new RegExp(String.raw`^\s*(${name})\s+${verb}\s*[:,]\s*[“"]`, 'du');
const trailing = new RegExp(String.raw`(?:\s*,)?\s*(?:(${name})\s+${verb}(?![\p{L}\p{M}\p{N}_])|${verb}\s+(${name}))`, 'duy');

export interface Turn {
  key: string;
  ordinal: number;
  spineIndex: number;
  paragraphIndex: number;
}

interface ExchangeEvidence {
  count: number;
  first: number;
}

function attributedTurn(paragraph: Sentence[], people: ReadonlyMap<string, string | null>): Turn | undefined {
  const text = paragraph.map((sentence) => sentence.text).join(' ');
  function resolve(match: RegExpExecArray): Turn | undefined {
    const position = match.indices?.[1]?.[0] ?? match.indices?.[2]?.[0];
    const key = people.get(termKey(match[1] ?? match[2]));
    if (!key || position === undefined) return;
    let end = 0;
    for (const sentence of paragraph) {
      end += sentence.text.length + 1;
      if (position < end) return { key, ordinal: sentence.ordinal, spineIndex: sentence.spineIndex, paragraphIndex: sentence.paragraphIndex };
    }
  }

  const prefix = leading.exec(text);
  const initial = prefix && resolve(prefix);
  if (initial) return initial;
  for (const quote of text.matchAll(/“[^“”]*”|"[^"]*"/gu)) {
    trailing.lastIndex = quote.index + quote[0].length;
    const match = trailing.exec(text);
    const turn = match && resolve(match);
    if (turn) return turn;
  }
}

export function speakerExchanges(
  sentences: readonly Sentence[],
  visible: readonly VisibleTerm[],
  cutoff: number,
  onExchange?: (previous: Turn, turn: Turn) => void,
): Map<string, Map<string, ExchangeEvidence>> {
  const people = new Map<string, string | null>();
  for (const person of visible) {
    if (person.type !== 'person') continue;
    for (const key of [person.key, termKey(person.displayName), ...person.aliases.map(termKey)]) {
      people.set(key, !people.has(key) || people.get(key) === person.key ? person.key : null);
    }
  }
  const exchanges = new Map<string, Map<string, ExchangeEvidence>>();
  if (!(cutoff >= 1) || people.size < 2) return exchanges;

  function addExchange(speaker: Turn, partner: Turn): void {
    let partners = exchanges.get(speaker.key);
    if (!partners) exchanges.set(speaker.key, (partners = new Map()));
    const evidence = partners.get(partner.key);
    if (evidence) {
      evidence.count++;
      evidence.first = Math.min(evidence.first, partner.ordinal);
    } else partners.set(partner.key, { count: 1, first: partner.ordinal });
  }

  let previous: Turn | undefined;
  let paragraph: Sentence[] = [];
  function finishParagraph(): void {
    if (!paragraph.length) return;
    const turn = attributedTurn(paragraph, people);
    if (!turn) return;
    if (previous && turn.spineIndex === previous.spineIndex && turn.paragraphIndex - previous.paragraphIndex <= 3 && turn.key !== previous.key) {
      addExchange(previous, turn);
      addExchange(turn, previous);
      onExchange?.(previous, turn);
    }
    previous = turn;
  }

  for (const sentence of sentences) {
    if (sentence.ordinal > cutoff) break;
    if (sentence.structure !== 'body') continue;
    if (paragraph[0]?.spineIndex !== sentence.spineIndex || paragraph[0].paragraphIndex !== sentence.paragraphIndex) {
      finishParagraph();
      paragraph = [];
    }
    paragraph.push(sentence);
  }
  finishParagraph();
  return exchanges;
}
