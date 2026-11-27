import type { AliasLink, Sentence, Term } from './model';
import { termKey } from './text-utils';

const PAIR = /(?<![\p{L}\p{N}'’-])(?=(\p{Lu}[\p{L}'’-]*)(,?\s+the\s+|\s+)(\p{Lu}[\p{L}'’-]*)(?![\p{L}\p{N}'’-]))/gu;
const TITLE = /^(?:house|lord|lady|captain|brightlord|highprince|king|queen|prince|princess|brightlady|sir|dame)$/;

const PERSON_CUES = 3;

interface PairEvidence {
  occurrences: number[];
  firstPlain?: number;
}

interface PersonInterval {
  start: number;
  end: number;
}

export function extractEpithetLinks(sentences: Sentence[], terms: Term[]): AliasLink[] {
  const singles = new Map(terms.filter((term) => term.wordCount === 1).map((term) => [term.key, term]));
  const evidence = new Map<string, Map<Term, PairEvidence>>();
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    for (const [, first, separator, last] of sentence.text.matchAll(PAIR)) {
      const epithet = termKey(last);
      const person = singles.get(termKey(first));
      if (!singles.has(epithet) || !person || person.key === epithet || TITLE.test(person.key)) continue;

      const pairs = evidence.get(epithet) ?? new Map<Term, PairEvidence>();
      const pair = pairs.get(person) ?? { occurrences: [] };
      pair.occurrences.push(sentence.ordinal);
      if (!separator.trim()) pair.firstPlain ??= sentence.ordinal;
      pairs.set(person, pair);
      evidence.set(epithet, pairs);
    }
  }

  const links: AliasLink[] = [];
  const personIntervals = new Map<Term, PersonInterval[]>();
  for (const [epithet, pairs] of evidence) {
    const candidates = [...pairs].filter(([, pair]) => pair.occurrences.length >= 3);
    if (!candidates.length) continue;
    const familyAt = familyNameOrdinal(pairs, personIntervals);
    for (const [person, { occurrences }] of candidates) {
      const link = qualifyingLink(singles.get(epithet)!, person, occurrences, familyAt);
      if (link) links.push(link);
    }
  }
  return links;
}

function familyNameOrdinal(pairs: Map<Term, PairEvidence>, cache: Map<Term, PersonInterval[]>): number {
  if ([...pairs.values()].filter((pair) => pair.firstPlain !== undefined).length < 2) return Infinity;

  let earliest = Infinity;
  let second = Infinity;
  for (const [person, { firstPlain }] of pairs) {
    if (firstPlain === undefined) continue;
    const intervals = cache.get(person) ?? personLikeIntervals(person);
    cache.set(person, intervals);
    const firstEvidence = Math.max(firstPlain, person.candidateOrdinal ?? 0);
    // Find when the observed predecessor first has enough person evidence.
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (intervals[mid].end <= firstEvidence) low = mid + 1;
      else high = mid;
    }
    const ordinal = Math.max(firstEvidence, intervals[low]?.start ?? Infinity);
    if (ordinal < earliest) {
      second = earliest;
      earliest = ordinal;
    } else {
      second = Math.min(second, ordinal);
    }
  }
  return second;
}

function personLikeIntervals(person: Term): PersonInterval[] {
  const intervals: PersonInterval[] = [];
  let ordinal = person.deltas[0] ?? Infinity;
  let count = 0;
  let tagged = 0;
  let active: PersonInterval | undefined;
  while (Number.isFinite(ordinal)) {
    const current = ordinal;
    do {
      if (person.features[count].person) tagged++;
      ordinal += person.deltas[++count] ?? Infinity;
    } while (ordinal === current);

    if (tagged * 10 >= count * 3) {
      if (!active) {
        active = { start: current, end: Infinity };
        intervals.push(active);
      }
    } else if (active) {
      active.end = current;
      active = undefined;
    }
  }
  return intervals;
}

function qualifyingLink(epithet: Term, person: Term, occurrences: number[], familyAt: number): AliasLink | undefined {
  const availableAt = Math.max(epithet.candidateOrdinal ?? 0, person.candidateOrdinal ?? 0);
  let nextCandidate = availableAt;
  let x = 0;
  let p = 0;
  let n = 0;
  let personMentions = 0;
  let capitalEpithet = 0;
  let lowerEpithet = 0;
  let nextX = epithet.deltas[0] ?? Infinity;
  let nextP = person.deltas[0] ?? Infinity;
  // Replay evidence by sentence so later mentions cannot change earlier links.
  while (true) {
    const ordinal = Math.min(nextX, nextP, nextCandidate, occurrences[n] ?? Infinity);
    if (ordinal >= familyAt) return undefined;
    if (nextCandidate === ordinal) nextCandidate = Infinity;
    while (nextX === ordinal) {
      if (epithet.features[x].capitalized) capitalEpithet++;
      else if (epithet.features[x].lowercase) lowerEpithet++;
      nextX += epithet.deltas[++x] ?? Infinity;
    }
    while (nextP === ordinal) {
      if (person.features[p].person) personMentions++;
      nextP += person.deltas[++p] ?? Infinity;
    }
    while (occurrences[n] === ordinal) n++;
    // "Kell Station" beside "the station": an epithet is a word the book mostly capitalises, and the first word is plainly someone.
    const epithetNamed = capitalEpithet >= lowerEpithet;
    if (ordinal >= availableAt && n >= 3 && n * 10 >= x && epithetNamed && personMentions >= PERSON_CUES && personMentions * 10 >= p * 3) {
      const link: AliasLink = { left: epithet.key, right: person.key, ordinal };
      if (Number.isFinite(familyAt)) link.untilOrdinal = familyAt;
      return link;
    }
  }
}
