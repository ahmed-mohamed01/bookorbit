import { describe, expect, it } from 'vitest';
import type { PassSlot } from '../pass/pass-cast';
import { DENSE_PROMPT_VERSION, factsUser, notesUser, NOW_MOMENT, NOW_SYSTEM, requiredIds, sceneUser } from './dense-prompt';

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

  it('asks a fiction note on a place, object or idea to lead with who acts, and leaves nonfiction alone', () => {
    const rule = 'lead with the character or group who does something to, with or about it in this stretch';
    expect(notesUser(text, [slot], context, 'fiction')).toContain(rule);
    expect(notesUser(text, [slot], context, 'fiction')).toContain('answer null for that id');
    expect(notesUser(text, [slot], context, 'nonfiction')).not.toContain(rule);
  });

  it('keeps places, objects and ideas off the Required line in fiction only', () => {
    const slots: PassSlot[] = [
      slot,
      { ...slot, id: 'e2', name: 'the Hollow Guild', kind: 'group' },
      { ...slot, id: 'e3', name: 'ember key', kind: 'object' },
    ];
    expect(requiredIds(slots, 'fiction')).toEqual(['e1', 'e2']);
    expect(requiredIds(slots, 'nonfiction')).toEqual(['e1', 'e2', 'e3']);
    expect(notesUser(text, slots, context, 'fiction')).toContain('Required: e1, e2');
  });

  it('excludes passing moments from fiction identity facts', () => {
    expect(factsUser(text, [slot], context, 'fiction')).toContain(
      'Leave out one-off touches, gestures, looks, sensations and feelings about a single moment.',
    );
  });

  it('bumps the prompt version so stored answers are regenerated', () => {
    expect(DENSE_PROMPT_VERSION).toBe(24);
  });
});

it('asks for the current situation in one sentence of prose', () => {
  expect(NOW_SYSTEM).toContain(
    'A now line is one sentence of prose about their current standing: where they are based, what they are pursuing or facing, and who they are with.',
  );
  expect(NOW_SYSTEM).toContain('Never include stat or level changes, skill ranks or a list.');
  expect(NOW_SYSTEM).toContain('never a single moment or scene');
  expect(NOW_SYSTEM).toContain('never tack on a "now" or "still" clause');
});

it('marks posture and passing moments as not a standing', () => {
  expect(NOW_MOMENT.test('He stands silent beside Tavia as she begins the engravings.')).toBe(true);
  expect(NOW_MOMENT.test('She remains silent beside Orrin, awaiting the tide.')).toBe(true);
  expect(NOW_MOMENT.test('Captain of the river watch, she is based at the old mill with Orrin.')).toBe(false);
  expect(NOW_MOMENT.test('Sworn to Pell, he guards the eastern standing stones.')).toBe(false);
});
