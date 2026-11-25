import { checkAnswer, checkCard, evidenceFloor, quoteVerified } from './book-knowledge-checks';
import type { BookKnowledgePassage } from '@bookorbit/types';
const passages: BookKnowledgePassage[] = [
  { number: 1, text: 'The “lumen lattice” bends light around sealed jars.', ordinals: [1], spineIndex: 0, paragraphIndex: 0, href: 'body.xhtml' },
];
const card = {
  meaning: 'It bends light around sealed jars.',
  meaningQuote: 'LUMEN   LATTICE',
  meaningPassage: 1,
  points: [{ text: 'It bends light around sealed jars.', quote: 'bends light around sealed jars', passage: 1 }],
  insufficient: false,
};
describe('Book Knowledge evidence checks', () => {
  it('normalizes case, whitespace and quotation characters', () => {
    expect(quoteVerified('the "lumen lattice"', passages[0])).toBe(true);
    expect(checkCard(card, passages).checks.meaningVerified).toBe(true);
    expect(quoteVerified('', passages[0])).toBe(false);
    expect(quoteVerified('light is cold', passages[0])).toBe(false);
  });
  it('drops unquoted claims and unknown passage numbers', () => {
    const result = checkCard(
      {
        ...card,
        meaningPassage: 8,
        points: [
          ...card.points,
          { text: 'Invented', quote: 'bends light around sealed jars', passage: 9 },
          { text: 'Invented', quote: 'not present', passage: 1 },
        ],
      },
      passages,
    );
    expect(result.card.points).toHaveLength(1);
    expect(result.card.insufficient).toBe(true);
    expect(result.checks).toEqual({ meaningVerified: false, droppedPoints: 2, unknownPassage: true });
  });
  it('marks a meaning with a mismatched quote as unverified', () => {
    expect(checkCard({ ...card, meaningQuote: 'invented' }, passages).checks.meaningVerified).toBe(false);
  });
  it('applies the deterministic evidence floor', () => {
    expect(evidenceFloor(passages, false)).toBe(true);
    expect(evidenceFloor(passages, true)).toBe(false);
    expect(evidenceFloor([...passages, ...passages], false)).toBe(false);
  });
  it('does not return unverified free-form answers', () => {
    const result = checkAnswer({ answer: 'Invented', points: [{ text: 'Invented', quote: 'missing', passage: 1 }], notInBook: false }, passages);
    expect(result.answer.notInBook).toBe(true);
    expect(result.answer.answer).not.toBe('Invented');
  });
  it('clears an unverified meaning even when a point is verified', () => {
    const result = checkCard({ ...card, meaningQuote: 'absent', points: [...card.points, ...card.points] }, passages);
    expect(result.checks.meaningVerified).toBe(false);
    expect(result.card).toMatchObject({ meaning: '', meaningQuote: '', insufficient: true });
    expect(result.card.points).toHaveLength(1);
    expect(checkCard({ ...card, meaningQuote: 'absent', points: [] }, passages).card.insufficient).toBe(true);
  });
  it('suppresses not-in-book claims despite verified points', () => {
    const result = checkAnswer({ answer: 'Unsupported claim', points: card.points, notInBook: true }, passages);
    expect(result.answer.answer).not.toBe('Unsupported claim');
    expect(result.answer.notInBook).toBe(true);
    expect(result.checks.meaningVerified).toBe(false);
  });
});

it('deduplicates normalized text or quotes and counts every drop', () => {
  const result = checkCard(
    {
      ...card,
      points: [
        ...card.points,
        { text: 'Another fact', quote: 'BENDS   LIGHT AROUND SEALED JARS', passage: 1 },
        { text: 'IT BENDS LIGHT.', quote: 'lumen lattice', passage: 1 },
        { text: 'bends light', quote: 'bends light around sealed jars', passage: 1 },
      ],
    },
    passages,
  );
  expect(result.card.points).toHaveLength(1);
  expect(result.checks.droppedPoints).toBe(3);
});
it('keeps a sole substantive point even when text copies its quote', () => {
  expect(
    checkCard({ ...card, points: [{ text: 'bends light', quote: 'bends light around sealed jars', passage: 1 }] }, passages).card.points,
  ).toHaveLength(1);
});
it('normalizes dash and ellipsis variants without allowing omitted words', () => {
  const passage = { ...passages[0], text: 'The spark–mesh waits… then glows.' };
  expect(quoteVerified('spark-mesh waits...', passage)).toBe(true);
  expect(quoteVerified('spark-mesh ... glows', passage)).toBe(false);
  expect(quoteVerified('spark mesh', passage)).toBe(false);
});

it('retains half-verified answers and suppresses all not-in-book claims', () => {
  const good = card.points[0];
  const bad = { text: 'Absent claim', quote: 'absent words', passage: 1 };
  const half = checkAnswer({ answer: 'It bends light around sealed jars.', points: [good, bad], notInBook: false }, passages);
  expect(half.answer.answer).toBe('It bends light around sealed jars.');
  expect(half.answer.notInBook).toBe(false);
  expect(half.checks.meaningVerified).toBe(false);
  expect(half.answer.points).toEqual([good]);
  const minority = checkAnswer({ answer: 'Absent claims.', points: [good, bad, bad], notInBook: false }, passages);
  expect(minority.answer.answer).toBe(good.text);
  expect(minority.answer.notInBook).toBe(false);
  expect(checkAnswer({ answer: 'Absent', points: [good], notInBook: true }, passages).answer.points).toEqual([]);
});

it('rejects term-only quotes and overlap consisting only of aliases', () => {
  const passage = { ...passages[0], text: 'The amber lattice folds. The amber lattice waits near a gate.' };
  const raw = {
    answer: 'The amber lattice flies.',
    notInBook: false,
    points: [
      { text: 'The amber lattice flies.', quote: 'The amber lattice', passage: 1 },
      { text: 'The amber lattice flies.', quote: 'The amber lattice waits near a gate', passage: 1 },
    ],
  };
  const result = checkAnswer(raw, [passage], ['amber lattice']);
  expect(result.checks.droppedPoints).toBe(2);
  expect(result.answer.points).toEqual([]);
});

it('rejects an ungrounded meaning and point even with verified quotes', () => {
  const result = checkCard(
    { ...card, meaning: 'It was invented by Shallan.', points: [{ ...card.points[0], text: 'It bends light around jars for Shallan.' }] },
    passages,
  );
  expect(result.card).toMatchObject({ meaning: '', meaningQuote: '', insufficient: true, points: [] });
  expect(result.checks).toMatchObject({ meaningVerified: false, droppedPoints: 1 });
});

it('replaces an answer with kept points when its names lack support', () => {
  const result = checkAnswer({ answer: 'It bends light for Shallan.', points: card.points, notInBook: false }, passages);
  expect(result.answer).toMatchObject({ answer: card.points[0].text, points: card.points, notInBook: false });
});

it('accepts names provided as visible aliases', () => {
  const meaning = 'It bends light in Shallan.';
  expect(checkCard({ ...card, meaning }, passages, ['Shallan']).card.meaning).toBe(meaning);
});
