import { describe, expect, it } from 'vitest';
import { answerPrompt, answerCharacterBudget, evidencePrompt, CARD_SCHEMA, ANSWER_SCHEMA } from './book-knowledge-prompts';
import type { BookKnowledgePassage } from '@bookorbit/types';

describe('compact evidence prompts', () => {
  it.each([CARD_SCHEMA, ANSWER_SCHEMA])('bounds evidence-heavy prompts including the plain-mode schema', (schema) => {
    const passages: BookKnowledgePassage[] = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      text: 'The glimnet might catch sparks. However, that apparent advantage is illusory.',
      ordinals: [index + 1],
      spineIndex: index,
      paragraphIndex: index,
      href: 'invented.xhtml',
    }));
    const prompt = evidencePrompt('Explain the glimnet. ' + 'Invented question? '.repeat(100), passages);
    const combined = prompt + JSON.stringify(schema);
    expect(combined.length).toBeLessThan(7800);
    const evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { number: number; text: string }[];
    expect(evidence.map((passage) => passage.number)).toEqual(passages.map((passage) => passage.number));
    expect(evidence.every((passage) => passage.text.endsWith('.'))).toBe(true);
    expect(evidence.every((p) => p.text.includes('advantage is illusory.'))).toBe(true);
    expect(prompt).toContain('never general knowledge');
    expect(prompt).toContain('at most 25 words');
    expect(prompt).toContain('Invented example');
  });
});

it('never cuts a passage before its rebuttal to fit the prompt', () => {
  const text = 'The glimnet might hold sparks. ' + 'A keeper waits quietly. '.repeat(400) + 'However, this apparent advantage is illusory.';
  const passage: BookKnowledgePassage = { number: 1, text, ordinals: [1], spineIndex: 0, paragraphIndex: 0, href: 'invented.xhtml' };
  const prompt = evidencePrompt('Explain the glimnet.', [passage]);
  expect(prompt.length).toBeLessThan(6800);
  const evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  expect(evidence).toEqual([]);
});

it('collects answer points before deciding whether to refuse', () => {
  expect(ANSWER_SCHEMA.required).toEqual(['points', 'answer', 'notInBook']);
  expect(Object.keys(ANSWER_SCHEMA.properties)).toEqual(['points', 'answer', 'notInBook']);
});

it('preserves the card prompt first line and numbered evidence', () => {
  const passage: BookKnowledgePassage = {
    number: 1,
    text: 'A glimnet catches stray sparks.',
    ordinals: [1],
    spineIndex: 0,
    paragraphIndex: 0,
    href: 'invented.xhtml',
  };
  const prompt = evidencePrompt('Explain the glimnet.', [passage]);
  expect(prompt.split('\n')[0]).toBe('Explain the glimnet.');
  expect(prompt.slice(prompt.lastIndexOf('\n') + 1)).toBe('[{"number":1,"text":"A glimnet catches stray sparks."}]');
});

it('bounds Ask prompts, skips oversized evidence and continues with intact passages', () => {
  const passage: BookKnowledgePassage = {
    number: 1,
    text: 'A glimnet catches stray sparks.',
    ordinals: [1],
    spineIndex: 0,
    paragraphIndex: 0,
    href: 'invented.xhtml',
  };
  const question = 'What is a glimnet?';
  const prompt = answerPrompt(question, [
    { ...passage, text: 'Invented oversized passage. '.repeat(400) },
    { ...passage, number: 2 },
    ...Array.from({ length: 100 }, (_, i) => ({ ...passage, number: i + 3, text: 'A keeper holds the spark jar. '.repeat(10) })),
  ]);
  expect(prompt.length).toBeLessThanOrEqual(6800);
  expect(prompt.split('\n')[0]).toBe('Answer this question using only the numbered passages: "What is a glimnet?"');
  const evidence = JSON.parse(prompt.split('Passages: ')[1]) as { number: number; text: string }[];
  expect(evidence[0]).toEqual({ number: 2, text: passage.text });
  expect(evidence.some((p) => p.number === 1)).toBe(false);
  expect(answerCharacterBudget(question)).toBe(6800 - answerPrompt(question, []).length - 2);
});

it('adds focused instructions immediately after the first line and budgets their full length', () => {
  const line =
    'The question is about one name or term. Say who or what it is and its role, then what has happened to it or been said about it so far, using the latest passage for its latest state. Attribute a fact only when its passage clearly names who it is about; never carry he, she or they across passages.';
  const question = 'Who is Vem?';
  const plain = answerPrompt(question, []);
  const focused = answerPrompt(question, [], true);
  expect(focused.split('\n')[1]).toBe(line);
  expect(plain).not.toContain(line);
  expect(focused.replace(line + '\n', '')).toBe(plain);
  expect(answerPrompt(question, [], false)).toBe(plain);
  expect(answerCharacterBudget(question) - answerCharacterBudget(question, true)).toBe(line.length + 1);
});
