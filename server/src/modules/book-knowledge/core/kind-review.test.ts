import { describe, expect, it } from 'vitest';
import {
  KIND_REVIEW_LIMIT,
  KIND_REVIEW_SYSTEM,
  conceptCandidates,
  namedTermCandidates,
  parseReviewAnswers,
  properNameCandidates,
  reviewBatches,
  reviewCheckpoint,
  reviewCheckpoints,
  reviewPassages,
  selectForReview,
  trimPassage,
} from './kind-review';
import type { KindDecision } from './kinds';
import type { Artifact, Mention, Sentence } from './model';
import type { RankedTerm } from './term-ranking';

function sentence(ordinal: number, text: string): Sentence {
  return { ordinal, text, spineIndex: 0, paragraphIndex: ordinal, href: 'invented.xhtml', structure: 'body', heading: false, emphasis: [] };
}
function mention(ordinal: number, alias: string): Mention {
  return { ordinal, alias, definition: false, capitalized: true, person: false, place: false, nested: false, structural: false };
}
function decision(kind: KindDecision['kind'], votes: KindDecision['votes'] = {}): KindDecision {
  return { kind, subtype: null, rule: 'R5 none', votes, mentions: 4 };
}
function visible(key: string, displayName: string, mentions: Mention[]): RankedTerm {
  return {
    key,
    displayName,
    aliases: [],
    mentions,
    first: mentions[0].ordinal,
    latest: mentions.at(-1)!.ordinal,
    count: mentions.length,
    rarity: 1,
    wordCount: 1,
    type: 'concept',
    score: 0,
    named: false,
  };
}

describe('kind review', () => {
  it('reviews at spine starts and every 300 body sentences, never past the reader', () => {
    const book: Sentence[] = [{ ...sentence(1, 'Cover.'), structure: 'front', spineIndex: 0 }];
    for (let ordinal = 2; ordinal <= 651; ordinal++) book.push({ ...sentence(ordinal, 'Text.'), spineIndex: 1 });
    for (let ordinal = 652; ordinal <= 700; ordinal++) book.push({ ...sentence(ordinal, 'Text.'), spineIndex: 2 });
    expect(reviewCheckpoints(book)).toEqual([
      { at: 301, cutoff: 301 },
      { at: 601, cutoff: 601 },
      { at: 652, cutoff: 651 },
    ]);
    expect([1, 300, 301, 651, 652, 700].map((cutoff) => reviewCheckpoint(book, cutoff))).toEqual([0, 0, 301, 601, 651, 651]);
    expect(reviewCheckpoint(book.slice(0, 651), 651)).toBe(601);
    for (let cutoff = 1; cutoff <= 700; cutoff++) {
      expect(reviewCheckpoint(book, cutoff)).toBeLessThanOrEqual(cutoff);
      expect(reviewCheckpoint(book.slice(0, cutoff), cutoff)).toBe(reviewCheckpoint(book, cutoff));
    }
  });

  it('selects unsorted and close entries from the top ranked terms only', () => {
    const ranked = Array.from({ length: KIND_REVIEW_LIMIT + 2 }, (_, index) => visible(`t${index}`, 'Veyra', [mention(1, 'Veyra')]));
    const decisions = new Map<string, KindDecision>(ranked.map(({ key }) => [key, decision('person', { person: 9 })]));
    decisions.set('t0', decision(null));
    decisions.set('t1', decision('person', { person: 10, place: 9 }));
    decisions.set('t2', decision('person', { person: 6, place: 4 }));
    decisions.set(`t${KIND_REVIEW_LIMIT}`, decision(null));
    expect(selectForReview(ranked, decisions)).toEqual([
      { key: 't0', reason: 'no kind' },
      { key: 't1', reason: 'top two close' },
    ]);
  });

  it('sends bracketed labels of plain words to the review wherever they rank', () => {
    const ranked = Array.from({ length: KIND_REVIEW_LIMIT + 2 }, (_, index) => visible(`t${index}`, 'Veyra', [mention(1, 'Veyra')]));
    const decisions = new Map<string, KindDecision>(ranked.map(({ key }) => [key, decision('person', { person: 9 })]));
    const label: KindDecision = { ...decision(null), rule: 'J4 bracket label' };
    decisions.set('t3', label);
    decisions.set(`t${KIND_REVIEW_LIMIT + 1}`, label);
    expect(selectForReview(ranked, decisions)).toEqual([
      { key: 't3', reason: 'bracket label' },
      { key: `t${KIND_REVIEW_LIMIT + 1}`, reason: 'bracket label' },
    ]);
  });

  it('finds untyped proper names with suitable capitalization and independent mentions', () => {
    const term = (name: string, ordinals = [1], capitalized = false, named = false) => ({
      ...visible(
        name,
        name,
        ordinals.map((ordinal) => ({ ...mention(ordinal, name), capitalized })),
      ),
      named,
    });
    const ranked = [
      term('Damien', [1], false, true),
      term('Irlefen', [1], true),
      term('Apex Palace'),
      term('Guard of the North'),
      term('BEEB', [1], true),
      term('GRACE', [1], true),
      term('Unit 7', [1], true),
      term('Palace', [1], true),
      term('Ape', [1], true),
      term('Cassian'),
      term('Cassian springs'),
      term('Cassian river gate'),
      term('Cassian river gate tower'),
      term('Cassian springs meadow'),
      term('cassian springs'),
      term('Cassian1 springs'),
      term('Cassian river Gate'),
      term('Quiet palace'),
      term('Order of the Northern Star Banner'),
      term('world of common words'),
      term('Lord', [1, 2], true),
      term('Lord Sera', [1]),
      term('Quenric', [1], true),
      term('brother Damien', [1]),
      term('engineer Irlefen', [1]),
    ];
    const decisions = new Map(ranked.map(({ key }) => [key, decision(key === 'Quenric' ? 'person' : null)]));
    expect(properNameCandidates(ranked, decisions).map(({ key }) => key)).toEqual([
      'Damien',
      'Irlefen',
      'Apex Palace',
      'Guard of the North',
      'BEEB',
      'Ape',
      'Cassian springs',
      'Cassian river gate',
      'Quiet palace',
      'Lord',
      'Lord Sera',
    ]);
  });

  it('adds at most 150 ranked proper names for fiction with no duplicate reviews', () => {
    const fillers = Array.from({ length: KIND_REVIEW_LIMIT - 1 }, (_, index) => visible(`t${index}`, 'world', [mention(1, 'world')]));
    const names = Array.from({ length: 151 }, (_, index) => {
      const name = `Name${String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26))}`;
      return visible(name, name, [mention(1, name)]);
    });
    const ranked = [names[0], ...fillers, ...names.slice(1)];
    const decisions = new Map(ranked.map(({ key }) => [key, decision(key.startsWith('Name') ? null : 'person', { person: 9 })]));
    expect(properNameCandidates(ranked, decisions)).toEqual(names.slice(0, 150));
    expect(selectForReview(ranked, decisions, 'fiction')).toEqual([
      { key: names[0].key, reason: 'no kind' },
      ...names.slice(1, 150).map(({ key }) => ({ key, reason: 'proper name' })),
    ]);
    expect(selectForReview(ranked, decisions, 'nonfiction', [sentence(1, '')])).toEqual([{ key: names[0].key, reason: 'no kind' }]);
  });

  it('finds untyped nonfiction compounds and hyphenated words named in two to four body sentences', () => {
    const term = (name: string, ordinals = [1, 2]) =>
      visible(
        name,
        name,
        ordinals.map((ordinal) => mention(ordinal, name)),
      );
    const ranked = [
      term('AI takeover'),
      term('tool-AI'),
      term('anthropic capture'),
      term('recursive preference learning system'),
      term('boxing', [1, 1, 1, 1, 1, 1, 1, 2]),
      term('capture mechanism'),
      term('recursive capture mechanism'),
      term('feedback loop', [1, 2, 3]),
      term('recursive feedback loop'),
      term('hierarchical inverse reinforcement learning model'),
      term('system 2'),
      term('calibration', [1, 1, 1, 1, 1, 1, 2, 5]),
      term('containment', Array<number>(8).fill(1)),
      term('one', Array<number>(4).fill(1).concat(Array<number>(4).fill(2))),
      term('alignment tax', [1, 4, 5]),
      term('reward hacking'),
      term('value learning', [1, 2, 3, 6, 7]),
      term('gradient masking'),
    ];
    const book = [
      sentence(1, ''),
      sentence(2, ''),
      sentence(3, ''),
      { ...sentence(4, ''), structure: 'front' as const },
      { ...sentence(5, ''), structure: 'index' as const },
      sentence(6, ''),
      sentence(7, ''),
    ];
    const decisions = new Map(ranked.slice(0, -1).map(({ key }) => [key, decision(key === 'reward hacking' ? 'idea' : null)]));
    expect(conceptCandidates(ranked, decisions, book).map(({ key }) => key)).toEqual([
      'AI takeover',
      'tool-AI',
      'anthropic capture',
      'recursive preference learning system',
      'recursive capture mechanism',
      'feedback loop',
      'recursive feedback loop',
    ]);
  });

  it('adds at most 150 ranked concepts for nonfiction with no duplicate reviews', () => {
    const book = [sentence(1, ''), sentence(2, '')];
    const fillers = Array.from({ length: KIND_REVIEW_LIMIT - 1 }, (_, index) => visible(`t${index}`, 'one', [mention(1, 'one')]));
    const concepts = Array.from({ length: 151 }, (_, index) => {
      const name = `concept ${String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26))}`;
      return visible(name, name, [mention(1, name), mention(2, name)]);
    });
    const ranked = [concepts[0], ...fillers, ...concepts.slice(1)];
    const decisions = new Map(ranked.map(({ key }) => [key, decision(key.startsWith('concept') ? null : 'person', { person: 9 })]));
    expect(conceptCandidates(ranked, decisions, book)).toEqual(concepts.slice(0, 150));
    expect(selectForReview(ranked, decisions, 'nonfiction', book)).toEqual([
      { key: concepts[0].key, reason: 'no kind' },
      ...concepts.slice(1, 150).map(({ key }) => ({ key, reason: 'concept' })),
    ]);
    expect(selectForReview(ranked, decisions, 'fiction', book)).toEqual([{ key: concepts[0].key, reason: 'no kind' }]);
  });

  it('trims a passage to 30 words around the mention', () => {
    const text = Array.from({ length: 60 }, (_, index) => `w${index}`).join(' ');
    const start = text.indexOf('w40');
    const trimmed = trimPassage(text, start, start + 3);
    expect(trimmed.startsWith('... w26 ')).toBe(true);
    expect(trimmed.endsWith(' w55 ...')).toBe(true);
    expect(trimPassage('Only Veyra here.', 5, 10)).toBe('Only Veyra here.');
  });

  it('takes passages from the name on its own before the longer names that hold it', () => {
    const sentences = [
      sentence(1, 'The Orlan Engine hummed below deck.'),
      sentence(2, 'Doctor Orlan checked the gauges.'),
      sentence(3, 'Nobody trusted the Orlan Engine.'),
    ];
    const artifact = { sentences, metadata: { titles: ['The Hollow Lantern'], authors: ['Mira Quell'] } } as Artifact;
    const nested = (ordinal: number) => ({ ...mention(ordinal, 'Orlan'), nested: true });
    const term = visible('orlan', 'Orlan', [nested(1), mention(2, 'Orlan'), nested(3)]);
    expect(reviewPassages(artifact, term, 3)).toEqual(['Doctor Orlan checked the gauges.']);
    const only = visible('orlan', 'Orlan', [nested(1), nested(3)]);
    expect(reviewPassages(artifact, only, 3)).toHaveLength(2);
  });

  it('takes passages only from mentions at or before the cut-off', () => {
    const sentences = [
      sentence(1, 'Veyra lit the lamp.'),
      sentence(2, 'Veyra kept the key.'),
      sentence(3, 'Veyra crossed the river.'),
      sentence(4, 'Veyra is secretly the queen.'),
      sentence(5, 'Veyra ruled the city.'),
    ];
    const artifact = { sentences, metadata: { titles: ['The Hollow Lantern'], authors: ['Mira Quell'] } } as Artifact;
    const term = visible(
      'veyra',
      'Veyra',
      [1, 2, 3, 4, 5].map((ordinal) => mention(ordinal, 'Veyra')),
    );
    const passages = reviewPassages(artifact, term, 3);
    expect(passages).toHaveLength(3);
    expect(passages.join(' ')).not.toMatch(/queen|ruled/);
    expect(reviewPassages(artifact, term, 3)).toEqual(passages);
    const batches = reviewBatches(
      artifact,
      [{ key: 'veyra', reason: 'no kind' }],
      new Map([['veyra', term]]),
      new Map([['veyra', decision(null)]]),
      3,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].keys).toEqual(['veyra']);
    expect(batches[0].user.split('\n').slice(0, 5)).toEqual(['Book: The Hollow Lantern by Mira Quell', 'Entries:', '[', ' {', '  "id": "e1",']);
    expect(batches[0].user).not.toMatch(/queen|ruled/);
  });

  it('parses answers by entry id and drops unknown answers', () => {
    const raw = '```json\n{"e1": " Person ", "e2": "spell", "e3": "junk"}\n```';
    expect(parseReviewAnswers(raw, ['a', 'b', 'c'])).toEqual(
      new Map([
        ['a', 'person'],
        ['c', 'junk'],
      ]),
    );
    expect(parseReviewAnswers('no json here', ['a'])).toBeUndefined();
    expect(parseReviewAnswers('[1, 2]', ['a'])).toBeUndefined();
  });

  it('sends a lowercase coinage the common-word rule would drop to the review, never a common word or one already in', () => {
    const times = (alias: string, count: number) => Array.from({ length: count }, (_, index) => mention(index + 1, alias));
    const ranked = [
      visible('zorblat', 'zorblat', times('zorblat', 3)),
      visible('thing', 'thing', times('thing', 40)),
      visible('quillmetal', 'quillmetal', times('quillmetal', 2)),
      visible('vexite', 'vexite', times('vexite', 9)),
      visible('Zorblat Hall', 'Zorblat Hall', times('Zorblat Hall', 3)),
    ];
    const decisions = new Map(ranked.map(({ key }) => [key, decision(key === 'vexite' ? 'object' : null)]));
    expect(namedTermCandidates(ranked, decisions).map(({ key }) => key)).toEqual(['zorblat']);
    expect(selectForReview(ranked, decisions, 'fiction')).toContainEqual({ key: 'zorblat', reason: 'no kind' });
  });

  it('keeps the original object and junk choices in the kind prompt', () => {
    expect(KIND_REVIEW_SYSTEM.split('\n').filter((line) => /^- (object|junk)/.test(line))).toMatchInlineSnapshot(`
      [
        "- object",
        "- junk: not a real entry (an exclamation, sound, curse, generic word, system message fragment, or the book's own title or author)",
      ]
    `);
  });
});
