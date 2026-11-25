import { describe, expect, it } from 'vitest';
import { createWinkNlp } from './wink';

describe('createWinkNlp', () => {
  it('creates many instances without the model growing each time', () => {
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30; i++) expect(createWinkNlp().readDoc('Vela’s lamp burned.').tokens().length()).toBeGreaterThan(0);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(512 * 1024 * 1024);
  });

  it('starts every instance from the same lexicon', () => {
    const used = createWinkNlp();
    used.readDoc('It was Vela’s.');
    expect(used.readDoc('Vela’s lamp burned.').tokens().length()).toBe(4);
    expect(createWinkNlp().readDoc('Vela’s lamp burned.').tokens().length()).toBe(5);
  });
});
