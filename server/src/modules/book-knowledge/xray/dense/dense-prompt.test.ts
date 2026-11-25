import { describe, expect, it } from 'vitest';
import type { PassSlot } from '../pass/pass-cast';
import { factsUser, notesUser, sceneUser } from './dense-prompt';

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
});
