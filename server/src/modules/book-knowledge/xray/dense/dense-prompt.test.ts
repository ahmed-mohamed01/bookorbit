import { describe, expect, it } from 'vitest';
import type { PassSlot } from '../pass/pass-cast';
import { DENSE_PROMPT_VERSION, factsUser, notesUser, sceneUser } from './dense-prompt';

const slot = { id: 'e1', name: 'Viv', aliases: [], kind: 'character', mentions: 4 } as unknown as PassSlot;
const context = { about: new Map([['e1', 'A princess.']]), abilities: new Map(), previous: 'Earlier, Viv fled.' };
const text = '[1] Viv ran.\n[2] She hid.';

describe('chunk prompts', () => {
  it.each(['fiction', 'nonfiction'] as const)('open notes, facts and the scene with the same stretch in %s', (mode) => {
    const opening = `<chapter>\n${text}\n</chapter>\n\n<task>\n`;
    for (const user of [notesUser(text, [slot], context, mode), factsUser(text, [slot], context, mode), sceneUser(text, [slot], context.about, mode)])
      expect(user.startsWith(opening)).toBe(true);
  });

  it('puts the summary before the stretch after the task', () => {
    const user = notesUser(text, [slot], context, 'fiction');
    expect(user.lastIndexOf('<before>\n')).toBeGreaterThan(user.indexOf('</task>'));
  });

  it.each(['fiction', 'nonfiction'] as const)('asks for notes in plain sentences of at most 100 words in %s', (mode) => {
    const user = notesUser(text, [slot], context, mode);
    expect(user).toContain('never more than 100');
    expect(user).toContain('usually 20 to 30 words');
    expect(user).toContain('one or two complete, plain sentences in the present tense');
    expect(user).toContain('No chains of verbs joined by commas');
  });

  it('bumps the prompt version so stored notes are not replayed', () => {
    expect(DENSE_PROMPT_VERSION).toBe(15);
  });
});
