import { describe, expect, it } from 'vitest';
import { repairJson } from './json-repair';

const parsed = (text: string): unknown => JSON.parse(repairJson(text));

describe('repairJson', () => {
  it('adds the closing braces a reply left off', () => {
    expect(parsed('{"notes":{"e1":{"note":"A walk.","n":[1,2]}}')).toEqual({ notes: { e1: { note: 'A walk.', n: [1, 2] } } });
    expect(parsed('{"notes":{},"summary":"Done."')).toEqual({ notes: {}, summary: 'Done.' });
  });

  it('turns a closer that does not match its bracket into the one that does', () => {
    expect(parsed('{"notes":{"e1":{"n":[1,2} },"e2":{"n":[3]}}}')).toEqual({ notes: { e1: { n: [1, 2] }, e2: { n: [3] } } });
    expect(parsed('{"notes":{"e1":{"n":[1,2}],"e2":{"n":[3]}}}')).toEqual({ notes: { e1: { n: [1, 2] }, e2: { n: [3] } } });
  });

  it('leaves brackets inside strings alone and closes an unterminated string', () => {
    expect(parsed('{"note":"a } and ] here","n":[1]}')).toEqual({ note: 'a } and ] here', n: [1] });
    expect(parsed('{"summary":"cut off')).toEqual({ summary: 'cut off' });
  });

  it('drops text after the top-level value closes', () => {
    expect(parsed('Here: {"a":[1]} trailing')).toEqual({ a: [1] });
  });
});
