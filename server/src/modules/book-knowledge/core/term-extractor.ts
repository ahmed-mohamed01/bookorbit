import type { ItemToken } from 'wink-nlp';
import { words, normalizeLast, termKey } from './text-utils';
export { words, normalizeLast, termKey } from './text-utils';
import { wordRarity } from './common-words';
import { extractAbbreviationLinks } from './abbreviations';
import { extractEpithetLinks } from './epithet-links';
import type { Mention, Sentence, Term } from './model';
import { createWinkNlp } from './wink';

const speech =
  /^(?:said|says|asked|asks|replied|replies|whispered|shouted|muttered|murmured|cried|answered|added|remarked|explained|argued|argues|wrote|writes|suggested|suggests|thought|thinks|wondered|knew|realized|remembered|believed|decided|insisted|observed|warned|agreed|continued|admitted|demanded|conceded|laughed)$/;
const humanAction =
  /^(?:smiled|grinned|nodded|shrugged|sighed|frowned|blinked|stared|gazed|glanced|looked|watched|turned|walked|sat|stepped|leaned|waved|gestured|winced|hesitated|followed|listened|spoke|felt|wanted|tried|began|recalled|noticed|understood|repeated|mumbled|screamed|squealed|rolled|shook)$/;
const humanPossession =
  /^(?:head|face|eyes?|hands?|arms?|legs?|fingers?|hair|voice|mind|thoughts?|wife|husband|mother|father|sister|brother|daughter|son|friend|shoulder|palm|lips|mouth)$/;
const geography =
  /^(?:city|town|village|kingdom|empire|country|province|continent|world|planet|island|river|lake|mountain|valley|polis|enclave|fort|capital|coast|sea|ocean)$/;
const dialogueFiller = /\b(?:fuck|fucking|shit|damn|bloody|hell|yeah|okay|alright|well|hey|oh|huh|um|uh)\b/i;
const forbidden = new Set(['ve', 'ver', 'vis']);
/** Lowercase words a capitalised name may hold inside it: "House of Many Gates". */
const NAME_CONNECTORS = new Set(['of', 'the', 'and']);
/** "Viv's mother": a relative named through someone, a person of their own. */
export const KIN_WORDS = new Set(['mother', 'father', 'sister', 'brother', 'wife', 'husband', 'son', 'daughter']);
/** A lowercase phrase this often in the book, ending in an uncommon word, is a term even when the tagger does not read it as a noun phrase. */
const NGRAM_REPEATS = 3;
const NGRAM_HEAD_RARITY = 0.5;
/** "the wyrm fled quickly": a run that ends on a verb or an adverb is a clause, not a name. */
const NGRAM_LAST_SKIP = ['VERB', 'ADV'];
const NGRAM_SKIP = ['DET', 'PRON', 'PART', 'ADP', 'AUX', 'CCONJ', 'SCONJ', 'NUM', 'PUNCT', 'SYM', 'INTJ'];
interface Token {
  value: string;
  normal: string;
  pos: string;
  spaced: boolean;
}
function nominalUse(tokens: Token[], index: number): boolean {
  return (
    ['NOUN', 'PROPN'].includes(tokens[index].pos) ||
    (tokens[index - 1]?.pos === 'DET' && !['NOUN', 'PROPN', 'ADJ'].includes(tokens[index + 1]?.pos ?? ''))
  );
}
interface Trie {
  children: Map<string, Trie>;
  key?: string;
}
// Each pass reads the body in book order from a new instance, so a sentence's tokens depend only on the text up to it.
export function createTokenizer(): (text: string) => Token[] {
  const nlp = createWinkNlp();
  return (text) => tokenize(nlp, text);
}
// wink dispatches by mapper identity, so binding these functions changes the output.
/* eslint-disable @typescript-eslint/unbound-method */
function tokenize(nlp: ReturnType<typeof createWinkNlp>, text: string): Token[] {
  const doc = nlp.readDoc(text);
  const tokens: Token[] = [];
  doc.tokens().each((t: ItemToken) =>
    tokens.push({
      value: t.out(nlp.its.value) as string,
      normal: (t.out(nlp.its.normal) as string).toLowerCase(),
      pos: t.out(nlp.its.pos) as string,
      spaced: (t.out(nlp.its.precedingSpaces) as string) !== '',
    }),
  );
  // wink splits hyphenated and en-dash compounds. Fold them before candidate extraction and matching; a spaced
  // en dash is punctuation, and the normal form uses the hyphen so both spellings are one term.
  const merged: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    while (
      (tokens[i + 1]?.value === '-' || (tokens[i + 1]?.value === '\u2013' && !tokens[i + 1].spaced && !tokens[i + 2]?.spaced)) &&
      tokens[i + 2] &&
      /^[\p{L}\p{N}]/u.test(tokens[i + 2].value)
    ) {
      token = {
        ...token,
        value: `${token.value}${tokens[i + 1].value}${tokens[i + 2].value}`,
        normal: `${token.normal}-${tokens[i + 2].normal}`,
        pos: tokens[i + 2].pos,
      };
      i += 2;
    }
    merged.push(token);
  }
  return merged;
}
/* eslint-enable @typescript-eslint/unbound-method */
const capital = (token: Token) => /^\p{Lu}/u.test(token.value);
/** Inner lowercase connectors between capitalised words, which a name may hold. */
function connectorAt(tokens: readonly Token[], index: number): boolean {
  return (
    index > 0 &&
    index < tokens.length - 1 &&
    NAME_CONNECTORS.has(tokens[index].value) &&
    tokens.every((token, at) => at === index || capital(token) || NAME_CONNECTORS.has(token.value))
  );
}
function valid(tokens: Token[]): boolean {
  const normals = tokens.map((t) => t.normal);
  if (tokens.filter((t) => t.pos === 'INTJ').length > tokens.length / 2) return false;
  if (normals.some((word) => /^([a-z])\1{3,}$|^[hm]+$|^(?:ha){3,}$/.test(word) || /[’'](?:m|re|ve|ll|d)$/i.test(word))) return false;
  if (tokens.length > 1 && new Set(normals).size === 1) return false;
  return tokens.every(
    (t, index) =>
      /^[\p{L}]+(?:[-\u2013’'][\p{L}]+)*$/u.test(t.value) &&
      !/[’']s$/i.test(t.value) &&
      !forbidden.has(t.normal.split(/[’']/)[0]) &&
      (!['DET', 'PRON', 'PART'].includes(t.pos) || connectorAt(tokens, index)),
  );
}
function definitionSignal(
  tokens: Token[],
  start: number,
  end: number,
  sentence: Sentence,
  alias: string,
): { definition: boolean; introduced: boolean; explicitDefinition: boolean } {
  const before = tokens
    .slice(Math.max(0, start - 7), start)
    .map((t) => t.normal)
    .join(' ');
  const after = tokens
    .slice(end, end + 12)
    .map((t) => t.normal)
    .join(' ');
  const explicitIntroduction =
    /(?:called|known as|idea of|call(?: this phenomenon| the phenomenon| it| this)?|term)(?: [‘’“”"'])?(?: (?:the|a|an))?(?: [‘’“”"'])?$/.test(
      before,
    ) ||
    (/\bby$/.test(before) && /^we mean\b/.test(after));
  const introduced =
    ((sentence.heading || (sentence.text.split(/\s+/).length <= 7 && !/[.!?;:]$/.test(sentence.text))) &&
      termKey(sentence.text.replace(/^(?:the|an?)\s+/i, '')) === termKey(alias)) ||
    sentence.emphasis.some((text) => termKey(text) === termKey(alias)) ||
    explicitIntroduction ||
    /this is(?: [‘’“”"'])?(?: (?:the|a|an))?(?: [‘’“”"'])?$/.test(before);
  const definition =
    introduced ||
    /^(?:is|are|was|were) (?:a|an|the)\b|^(?:refers to|means)\b|^holds\b|^thesis\b|^, (?:which|in other words)\b|^\( (?:a|an)\b/.test(after);
  return { definition, introduced, explicitDefinition: explicitIntroduction || /^(?:refers to|means)\b/.test(after) };
}

/** Lowercase two- and three-word runs with no function word and an uncommon last word that is neither a verb nor an adverb. */
function lowercaseGrams(tokens: readonly Token[], found: (tokens: Token[]) => void): void {
  for (let start = 0; start < tokens.length; start++)
    for (let size = 2; size <= 3 && start + size <= tokens.length; size++) {
      const gram = tokens.slice(start, start + size);
      if (gram.some((token) => !/^\p{Ll}[\p{Ll}-]*$/u.test(token.value) || NGRAM_SKIP.includes(token.pos))) break;
      const last = gram.at(-1)!;
      if (NGRAM_LAST_SKIP.includes(last.pos)) continue;
      if (wordRarity(normalizeLast(last.normal)) >= NGRAM_HEAD_RARITY) found(gram);
    }
}

/** "Viv's mother": a capitalised name, a possessive and a kin word. */
function kinAt(tokens: readonly Token[], index: number): boolean {
  return capital(tokens[index]) && /^[’']s$/.test(tokens[index + 1]?.value ?? '') && KIN_WORDS.has(tokens[index + 2]?.normal ?? '');
}

export function extractTerms(sentences: Sentence[]): Term[] {
  const candidates = new Map<string, Set<string>>();
  const gramCounts = new Map<string, number>();
  const add = (tokens: Token[], target = candidates): void => {
    if (!tokens.length || tokens.length > 4 || !valid(tokens)) return;
    const alias = tokens.map((t) => t.value).join(' ');
    const key = termKey(alias);
    if (!key || (tokens.length === 1 && /^(?:mr|mrs|ms|dr|prof|sir)$/.test(key))) return;
    const aliases = target.get(key) ?? new Set<string>();
    aliases.add(alias.toLowerCase());
    target.set(key, aliases);
  };
  const collect = (tokens: Token[], target: Map<string, Set<string>>): void => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (nominalUse(tokens, i)) {
        add([token], target);
        for (let start = i; start >= Math.max(0, i - 3); start--) {
          if (!['ADJ', 'NOUN', 'PROPN'].includes(tokens[start].pos) && !(tokens[start].pos === 'VERB' && /(?:ed|ing)$/.test(tokens[start].normal)))
            break;
          add(tokens.slice(start, i + 1), target);
        }
      }
      if (/ing$/.test(token.normal) && tokens[i - 1]?.pos === 'NOUN') add(tokens.slice(i - 1, i + 1), target);
      if (/^\p{Lu}/u.test(token.value)) {
        for (let end = i + 1; end <= Math.min(tokens.length, i + 4); end++) {
          const last = tokens[end - 1];
          if (!capital(last)) {
            // "House of Many Gates": a connector stays inside the span only when a capitalised word follows it.
            if (NAME_CONNECTORS.has(last.value) && end < tokens.length && capital(tokens[end])) continue;
            break;
          }
          if (end - i > 1 || i > 0) add(tokens.slice(i, end), target);
        }
      }
    }
  };
  // Two bounded token passes avoid retaining an NLP document for the whole book.
  const firstPass = createTokenizer();
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    const tokens = firstPass(sentence.text);
    collect(tokens, candidates);
    lowercaseGrams(tokens, (gram) => {
      if (!valid(gram)) return;
      const key = termKey(gram.map((t) => t.value).join(' '));
      gramCounts.set(key, (gramCounts.get(key) ?? 0) + 1);
    });
  }
  const recurring = new Set<string>();
  for (const [key, count] of gramCounts)
    if (count >= NGRAM_REPEATS) {
      recurring.add(key);
      candidates.set(key, (candidates.get(key) ?? new Set()).add(key));
    }
  gramCounts.clear();

  const trie: Trie = { children: new Map() };
  for (const [key, aliases] of candidates) {
    for (const alias of aliases) {
      let node = trie;
      const parts = words(alias);
      parts[parts.length - 1] = normalizeLast(parts[parts.length - 1]);
      for (const part of parts) {
        let child = node.children.get(part);
        if (!child) {
          child = { children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      }
      node.key = key;
    }
  }
  const mentions = new Map<string, Mention[]>();
  const candidateOrdinals = new Map<string, number>();
  const secondPass = createTokenizer();
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    const tokens = secondPass(sentence.text);
    const local = new Map<string, Set<string>>();
    collect(tokens, local);
    lowercaseGrams(tokens, (gram) => {
      const key = termKey(gram.map((t) => t.value).join(' '));
      if (recurring.has(key)) local.set(key, new Set([key]));
    });
    for (const key of local.keys()) {
      if (!candidateOrdinals.has(key)) candidateOrdinals.set(key, sentence.ordinal);
    }
    const matches: { key: string; start: number; end: number; kin?: boolean }[] = [];
    for (let start = 0; start < tokens.length; start++) {
      let node: Trie | undefined = trie;
      for (let end = start; end < Math.min(tokens.length, start + 4); end++) {
        // Normalize only the terminal word. Intermediate words must stay exact.
        const terminal: Trie | undefined = node.children.get(normalizeLast(tokens[end].normal));
        if (terminal?.key) matches.push({ key: terminal.key, start, end: end + 1 });
        node = node.children.get(tokens[end].normal);
        if (!node) break;
      }
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      if (match.end - match.start === 1) continue;
      if (!local.has(match.key)) {
        matches.splice(i, 1);
        continue;
      }
      const phrase = tokens.slice(match.start, match.end);
      const head = phrase.at(-1)!;
      const nounHead = ['NOUN', 'PROPN'].includes(head.pos);
      const ingHead = /ing$/.test(head.normal) && phrase.at(-2)?.pos === 'NOUN';
      const nominal = phrase.every(
        (token) => ['ADJ', 'NOUN', 'PROPN'].includes(token.pos) || (token.pos === 'VERB' && /(?:ed|ing)$/.test(token.normal)),
      );
      const capitalized = phrase.every((token, index) => capital(token) || connectorAt(phrase, index));
      // A recurring lowercase run may hold a non-nominal word, but it still needs a noun at its end.
      if (!capitalized && (!(nounHead || ingHead) || (!nominal && !recurring.has(match.key)))) matches.splice(i, 1);
    }
    for (let start = 0; start < tokens.length; start++)
      if (kinAt(tokens, start)) {
        const key = termKey(`${tokens[start].value}'s ${tokens[start + 2].value}`);
        if (!candidateOrdinals.has(key)) candidateOrdinals.set(key, sentence.ordinal);
        matches.push({ key, start, end: start + 3, kin: true });
      }
    const maxEnd = new Map<number, number>();
    // A kin phrase leaves the name inside it a mention of that name.
    for (const match of matches) if (!match.kin) maxEnd.set(match.start, Math.max(maxEnd.get(match.start) ?? 0, match.end));
    for (const match of matches) {
      let nested = false;
      for (let start = Math.max(0, match.start - 3); start <= match.start; start++) {
        const end = maxEnd.get(start) ?? 0;
        if (end >= match.end && end - start > match.end - match.start) nested = true;
      }
      const alias = match.kin
        ? `${tokens[match.start].value}'s ${tokens[match.end - 1].value}`
        : tokens
            .slice(match.start, match.end)
            .map((t) => t.value)
            .join(' ');
      const before = tokens[match.start - 1]?.normal ?? '';
      const after = tokens[match.end]?.normal ?? '';
      const definition = definitionSignal(tokens, match.start, match.end, sentence, alias);
      const phrase = tokens.slice(match.start, match.end);
      if (
        !match.kin &&
        !definition.definition &&
        phrase.length > 1 &&
        (['ADP', 'DET', 'INTJ', 'CCONJ', 'SCONJ', 'ADV'].includes(phrase[0].pos) ||
          (['VERB', 'AUX'].includes(phrase.at(-1)!.pos) && !(/ing$/.test(phrase.at(-1)!.normal) && phrase.at(-2)?.pos === 'NOUN')))
      )
        continue;
      const named =
        !phrase.some((t) => ['AUX', 'PRON', 'DET', 'ADP', 'CCONJ', 'SCONJ', 'ADV'].includes(t.pos)) &&
        phrase.every((token) => /^\p{Lu}/u.test(token.value));
      const left = tokens
        .slice(Math.max(0, match.start - 4), match.start)
        .map((t) => t.normal)
        .join(' ');
      const right = tokens
        .slice(match.end, match.end + 4)
        .map((t) => t.normal)
        .join(' ');
      const possessive = /^[’']s$/.test(after) && humanPossession.test(tokens[match.end + 1]?.normal ?? '');
      const person =
        named &&
        !geography.test(phrase[0].normal) &&
        !/^[A-Z-]{2,}$/.test(alias) &&
        !(before === 'of' && geography.test(tokens[match.start - 2]?.normal ?? '')) &&
        (/(?:researcher|scientist|mathematician|physicist|economist|philosopher|author|god|goddess) (?:of [\p{L}]+ , )?$/u.test(left + ' ') ||
          /^(?:mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|professor|captain|capt\.?|sir|lady|lord|dame|king|queen|colonel|lieutenant|president|judge|saint|master|branchmaster)$/.test(
            before,
          ) ||
          speech.test(before) ||
          speech.test(after) ||
          humanAction.test(after) ||
          ((after === 'ran' || after === 'stood') && match.start <= 1) ||
          possessive ||
          /^, who\b|^\( (?:1[5-9]|20)\d{2}\b|^et al\b/.test(right) ||
          /according to$/.test(left) ||
          (before === ',' && /^[?!,][”"’']?/.test(tokens[match.end]?.value ?? '') && /[“"‘]/.test(sentence.text)));
      const place =
        named &&
        !/^(?:theory|research|science|language|algorithm|method|system)$/.test(phrase.at(-1)!.normal) &&
        !person &&
        ((/^(?:in|at|near|across|within)$/.test(before) &&
          phrase.every((t) => t.pos === 'PROPN') &&
          !(tokens[match.end]?.pos === 'NOUN' && /^[a-z]/.test(tokens[match.end].value)) &&
          !/^[’']s$/.test(after) &&
          !/^[A-Z-]{2,}$/.test(alias) &&
          !/^(?:english|french|german|spanish|latin|arabic|chinese|japanese)$/.test(alias.toLowerCase())) ||
          (before === 'of' && geography.test(tokens[match.start - 2]?.normal ?? '') && phrase.at(-1)!.pos === 'PROPN') ||
          (geography.test(after) && phrase.every((t) => t.pos === 'PROPN')) ||
          (before === 'called' && geography.test(tokens[match.start - 2]?.normal ?? '')));
      // Reuse the existing per-mention flag; visibility can restore a defined or mid-sentence phrase.
      const fragment =
        !definition.definition && dialogueFiller.test(alias) && !(match.start > 0 && !/^[“"‘]$/.test(tokens[match.start - 1]?.value ?? ''));
      const list = mentions.get(match.key) ?? [];
      list.push({
        ordinal: sentence.ordinal,
        noun: nominalUse(tokens, match.start),
        proper: tokens[match.start].pos === 'PROPN',
        functionWord: ['ADP', 'ADV', 'AUX', 'CCONJ', 'DET', 'INTJ', 'PART', 'PRON', 'SCONJ'].includes(phrase[0].pos),
        modifier: phrase[0].pos === 'ADJ' && ['ADJ', 'NOUN', 'PROPN'].includes(tokens[match.end]?.pos ?? ''),
        forgiven:
          fragment ||
          (match.end - match.start > 1 &&
            !tokens.slice(match.start, match.end).every((token) => /^\p{Lu}/u.test(token.value)) &&
            tokens.slice(match.start, match.end).some((token) => !['ADJ', 'NOUN', 'PROPN'].includes(token.pos))),
        alias,
        ...definition,
        capitalized: tokens.slice(0, match.start).some((t) => /[\p{L}\p{N}]/u.test(t.value)) && /^\p{Lu}/u.test(alias),
        person: person || match.kin === true,
        place,
        nested,
        structural:
          sentence.heading || sentence.caption === true || (/^(chapter|box|table|figure)$/.test(match.key) && tokens[match.end]?.pos === 'NUM'),
        determiner: tokens[match.start - 1]?.pos === 'DET',
        lowercase: alias === alias.toLowerCase(),
      });
      mentions.set(match.key, list);
    }
  }
  return [...mentions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      let previous = 0;
      const parts = key.split(' ');
      return {
        key,
        wordCount: parts.length,
        candidateOrdinal: candidateOrdinals.get(key),
        rarity: parts.reduce((sum, part) => sum + wordRarity(part), 0) / parts.length,
        deltas: list.map((mention) => {
          const delta = mention.ordinal - previous;
          previous = mention.ordinal;
          return delta;
        }),
        features: list.map((mention) => ({
          alias: mention.alias,
          noun: mention.noun,
          proper: mention.proper,
          functionWord: mention.functionWord,
          modifier: mention.modifier,
          explicitDefinition: mention.explicitDefinition,
          forgiven: mention.forgiven,
          definition: mention.definition,
          introduced: mention.introduced,
          capitalized: mention.capitalized,
          person: mention.person,
          place: mention.place,
          nested: mention.nested,
          structural: mention.structural,
          determiner: mention.determiner,
          lowercase: mention.lowercase,
        })),
      };
    });
}

const WORD = /[\p{L}\p{N}]+(?:[-\u2013’'][\p{L}\p{N}]+)*/gu;
// Fiction says "the tavern was called the First Spire" and "what is left is called to...": only a name or a
// multi-word term with an uncommon word may stand on either side of an identity statement.
function nameLike(original: string[]): boolean {
  if (original.every((word) => /^\p{Lu}/u.test(word))) return true;
  return original.length > 1 && original.some((word) => wordRarity(word.toLowerCase()) > 0.1);
}
export function extractAliasLinks(sentences: Sentence[], terms: Term[]): import('./model').AliasLink[] {
  const keys = new Set(terms.map((term) => term.key));
  const links: import('./model').AliasLink[] = [];
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    const match = /\b(?:is|was|are|were)\s+(?:also\s+)?(?:called|known as)\s+/i.exec(sentence.text);
    if (!match) continue;
    const leftOriginal = sentence.text.slice(0, match.index).match(WORD) ?? [];
    const rightOriginal = (
      sentence.text
        .slice(match.index + match[0].length)
        .split(/[.,;:!?]/)[0]
        .match(WORD) ?? []
    ).filter((word, i) => i > 0 || !['a', 'an', 'the'].includes(word.toLowerCase()));
    let left = '';
    let right = '';
    for (let size = Math.min(4, leftOriginal.length); size >= 1; size--) {
      const original = leftOriginal.slice(-size);
      const key = termKey(original.join(' '));
      if (keys.has(key)) {
        if (nameLike(original)) left = key;
        break;
      }
    }
    for (let size = Math.min(4, rightOriginal.length); size >= 1; size--) {
      const original = rightOriginal.slice(0, size);
      const key = termKey(original.join(' '));
      if (keys.has(key)) {
        if (nameLike(original)) right = key;
        break;
      }
    }
    if (left && right && left !== right) links.push({ left, right, ordinal: sentence.ordinal });
  }
  return [...links, ...extractAbbreviationLinks(sentences, keys), ...extractEpithetLinks(sentences, terms)];
}
