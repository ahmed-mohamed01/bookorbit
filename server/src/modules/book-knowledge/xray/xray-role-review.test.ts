import type { Artifact, Sentence } from '../core/model';
import { rankImportance, withoutNoRole } from './xray-entities';
import { entity } from './xray-fixtures.testing';
import {
  EVERYDAY_OBJECT_REVIEW_SYSTEM,
  EVERYDAY_OBJECT_REVIEW_VERSION,
  missingRoleVoteShare,
  NONFICTION_ROLE_REVIEW_SYSTEM,
  parseRoleAnswers,
  ROLE_PASSAGE_CHARS,
  ROLE_REVIEW_BATCH,
  ROLE_REVIEW_BATCH_MAX,
  ROLE_REVIEW_LIMIT,
  roleReviewBatches,
  roleReviewCandidates,
  roleReviewGroups,
  roleReviewSystem,
  tallyRoleVotes,
  type RoleAnswer,
} from './xray-role-review';

function artifactOf(texts: readonly string[], structures: Partial<Record<number, Sentence['structure']>> = {}): Artifact {
  return {
    sentences: texts.map((text, index) => ({
      ordinal: index + 1,
      spineIndex: Math.floor(index / 5),
      paragraphIndex: index,
      href: 'invented.xhtml',
      text,
      structure: structures[index + 1] ?? 'body',
      heading: false,
      emphasis: [],
    })),
    terms: [],
    aliasLinks: [],
    seeds: [],
    fingerprint: 'invented',
    formatVersion: 1,
    textVersion: 1,
    termsVersion: 1,
  };
}

describe('roleReviewCandidates', () => {
  it('judges every entry, characters included, and never the narrator', () => {
    const judged = [
      entity('e1', 'place', [], { name: 'Marrowgate' }),
      entity('e2', 'object', [], { name: 'lantern' }),
      entity('e3', 'idea', [], { name: 'Glimmer Accord' }),
      entity('e4', 'group', [], { name: 'Ashen Guard' }),
      entity('e5', 'idea', [], { name: 'healer', sub: 'title' }),
      entity('e6', 'object', [], { name: 'Bay Two' }),
      entity('e7', 'character', [], { name: 'Quellin' }),
    ];
    const skipped = [entity('narrator', 'character', [], { name: 'the narrator' })];
    expect(roleReviewCandidates([...judged, ...skipped].reverse())).toEqual({ candidates: judged, trimmed: 0 });
  });

  it('trims the least mentioned past the cap and returns the rest in key order', () => {
    const entries = Array.from({ length: ROLE_REVIEW_LIMIT + 2 }, (_, index) =>
      entity(`e${String(index).padStart(4, '0')}`, 'object', [], { name: 'sled', count: index + 1 }),
    );
    expect(roleReviewCandidates([...entries].reverse())).toEqual({ candidates: entries.slice(2), trimmed: 2 });
  });

  it('orders by term key, not by the positional prompt id', () => {
    const tarn = entity('e1', 'place', [], { key: 'tarn' });
    const ash = entity('e2', 'object', [], { key: 'ash' });
    expect(roleReviewCandidates([tarn, ash]).candidates.map(({ key }) => key)).toEqual(['ash', 'tarn']);
  });
});

describe('roleReviewBatches', () => {
  it('lists each candidate with its count and up to five spread passages through the cut', () => {
    const texts = Array.from({ length: 12 }, (_, index) => `Marker${index + 1}: Brask hummed in the hold.`);
    const brask = entity('e1', 'object', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { name: 'Brask', names: [{ text: 'Brask', ordinal: 1 }] });
    const quellin = entity('e2', 'character', [1], { name: 'Quellin' });
    const [batch] = roleReviewBatches(artifactOf(texts, { 4: 'index' }), [brask], [quellin, brask], 10);
    const lines = batch.user.split('\n');
    expect(lines[0]).toBe('Candidates:');
    expect(lines).toContain('id e1 | Brask | 10 sentences');
    const passages = lines.filter((line) => line.startsWith('  - '));
    const markers = passages.map((line) => Number(line.match(/Marker(\d+)/)?.[1]));
    expect(markers).toEqual([1, 3, 6, 8, 10]);
    expect(batch.ordinals).toEqual(markers);
    expect(batch.keys).toEqual(['e1']);
  });

  it('prefers sentences that name the entry or an alias and caps each passage', () => {
    const long = `${'The hull creaked and settled under the weight of the cargo. '.repeat(8)}Then the Velmiri Lamp flickered once more.${' The crew slept.'.repeat(30)}`;
    const texts = ['They talked about nothing in particular.', long, 'Someone lit the lamp of Velmiri again.'];
    const lamp = entity('e1', 'object', [1, 2, 3], { name: 'Velmiri Lamp', names: [{ text: 'lamp of Velmiri', ordinal: 3 }] });
    const [batch] = roleReviewBatches(artifactOf(texts), [lamp], [lamp], 3);
    const passages = batch.user.split('\n').filter((line) => line.startsWith('  - '));
    expect(passages).toHaveLength(2);
    expect(passages[0]).toContain('Velmiri Lamp');
    expect(passages[0].length - 4).toBeLessThanOrEqual(ROLE_PASSAGE_CHARS);
    expect(passages[0]).toMatch(/^ {2}- \.\.\..*\.\.\.$/);
    expect(passages[1]).toBe('  - Someone lit the lamp of Velmiri again.');
    expect(batch.ordinals).toEqual([2, 3]);
  });

  it('numbers ids within each batch', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => entity(`e${index}`, 'object', [1], { name: `vex${index}` }));
    const batches = roleReviewBatches(artifactOf(['The vex hummed.']), candidates, candidates, 1);
    expect(batches.length).toBeGreaterThan(1);
    const [first, second] = batches;
    expect(second.user).toContain(`id e1 | vex${first.keys.length} | 1 sentences`);
    expect(batches.flatMap(({ keys }) => keys)).toEqual(candidates.map(({ key }) => key));
  });

  it('names only the other entries whose name holds a candidate or is held in it', () => {
    const fused = entity('e1', 'character', [1], { name: 'Quill and Bram' });
    const cast = [
      fused,
      entity('e2', 'character', [1], { name: 'Quill' }),
      entity('e3', 'character', [1], { name: 'Bram' }),
      entity('e4', 'place', [1], { name: 'Tarnholt' }),
    ];
    const [batch] = roleReviewBatches(artifactOf(['Quill and Bram rode to Tarnholt.']), [fused], cast, 1);
    expect(batch.user.split('\n')[0]).toBe("Other entries whose name contains or is part of a candidate's: Bram; Quill");
  });

  it('keeps every other prompt the same when one entry joins or leaves the cast', () => {
    const named = (index: number) => entity(`e${index}`, 'object', [1], { key: `vex${String(index).padStart(3, '0')}`, name: `vex${index}` });
    const before = Array.from({ length: 120 }, (_, index) => named(index));
    const after = [...before.slice(0, 60), named(500), ...before.slice(60)];
    const prompts = (cast: typeof before) =>
      new Set(roleReviewBatches(artifactOf(['The vex hummed.']), roleReviewCandidates(cast).candidates, cast, 1).map(({ user }) => user));
    const old = prompts(before);
    const changed = [...prompts(after)].filter((user) => !old.has(user));
    expect(changed.length).toBeLessThanOrEqual(2);
  });
});

describe('roleReviewGroups', () => {
  it('averages near the batch size and never passes the cap', () => {
    const keys = Array.from({ length: 2400 }, (_, index) => ({ key: `term${index}` })).sort((a, b) => (a.key < b.key ? -1 : 1));
    const groups = roleReviewGroups(keys);
    expect(groups.flat()).toEqual(keys);
    expect(Math.max(...groups.map((group) => group.length))).toBeLessThanOrEqual(ROLE_REVIEW_BATCH_MAX);
    const mean = keys.length / groups.length;
    expect(mean).toBeGreaterThan(ROLE_REVIEW_BATCH * 0.6);
    expect(mean).toBeLessThan(ROLE_REVIEW_BATCH * 1.4);
  });
});

describe('parseRoleAnswers', () => {
  it('reads keep, minor and junk and leaves out missing ids and unknown values', () => {
    const keys = ['sled', 'glimmerstone', 'barracks', 'healer'];
    const expected = new Map<string, RoleAnswer>([
      ['sled', 'keep'],
      ['glimmerstone', 'junk'],
      ['barracks', 'minor'],
    ]);
    expect(parseRoleAnswers('{"e1":"keep","e2":"junk","e3":"minor"}', keys)).toEqual(expected);
    expect(parseRoleAnswers('```json\n{"e1":"KEEP","e2":"Junk","e3":"minor","e4":"role","e9":"junk"}\n```', keys)).toEqual(expected);
    expect(parseRoleAnswers('{}', keys)).toEqual(new Map());
    expect(parseRoleAnswers('I would skip these.', keys)).toBeUndefined();
    expect(parseRoleAnswers('{"e1":"junk","e2":', keys)).toBeUndefined();
  });

  it('judges a nonfiction book with its own prompt', () => {
    expect(roleReviewSystem('fiction')).toBe(EVERYDAY_OBJECT_REVIEW_SYSTEM);
    expect(roleReviewSystem('nonfiction')).toBe(NONFICTION_ROLE_REVIEW_SYSTEM);
    expect(NONFICTION_ROLE_REVIEW_SYSTEM).toContain('never by the words inside it');
    expect(NONFICTION_ROLE_REVIEW_SYSTEM.endsWith('for every id given.')).toBe(true);
  });

  it('carries the junk judge prompt', () => {
    expect(EVERYDAY_OBJECT_REVIEW_VERSION).toBe(7);
    expect(EVERYDAY_OBJECT_REVIEW_SYSTEM).toContain('a name used only as an exclamation, oath or figure of speech');
    expect(EVERYDAY_OBJECT_REVIEW_SYSTEM).toContain('never by the words inside it');
    expect(EVERYDAY_OBJECT_REVIEW_SYSTEM).toContain('"Focus" as a stat a character raises is keep');
    expect(EVERYDAY_OBJECT_REVIEW_SYSTEM.endsWith('for every id given.')).toBe(true);
  });
});

describe('missingRoleVoteShare', () => {
  it('counts a failed sample and an id left out alike, over every vote asked', () => {
    const keep = new Map<string, RoleAnswer>([
      ['a', 'keep'],
      ['b', 'junk'],
    ]);
    const partial = new Map<string, RoleAnswer>([['a', 'keep']]);
    expect(missingRoleVoteShare([{ keys: ['a', 'b'], samples: [keep, partial, null] }])).toBeCloseTo(3 / 6);
    expect(missingRoleVoteShare([])).toBe(0);
  });
});

describe('tallyRoleVotes', () => {
  const keys = ['a', 'b', 'c', 'd'];
  const sample = (answers: Record<string, RoleAnswer>) => new Map(Object.entries(answers));

  it('removes on three junk of three, escalates two and keeps one', () => {
    const votes = tallyRoleVotes(keys, [
      sample({ a: 'junk', b: 'junk', c: 'minor', d: 'junk' }),
      sample({ a: 'junk', b: 'keep', c: 'minor', d: 'junk' }),
      sample({ a: 'keep', b: 'keep', d: 'junk' }),
    ]);
    expect([...votes.removed]).toEqual(['d']);
    expect([...votes.escalate]).toEqual(['a']);
    expect([...votes.minor]).toEqual(['c']);
  });

  it('removes an escalated entry only when both extra votes are junk too', () => {
    const first = [
      sample({ a: 'junk', b: 'junk', c: 'junk' }),
      sample({ a: 'junk', b: 'junk', c: 'minor' }),
      sample({ a: 'keep', b: 'minor', c: 'junk' }),
    ];
    const extra = new Map([
      ['a', [sample({ a: 'junk' }), sample({ a: 'junk' })]],
      ['b', [sample({ b: 'junk' }), sample({ b: 'minor' })]],
      ['c', [sample({ c: 'junk' }), null]],
    ]);
    const votes = tallyRoleVotes(keys, first, new Set(), extra);
    expect([...votes.removed]).toEqual(['a']);
    expect(votes.escalate.size).toBe(0);
    expect([...votes.minor]).toEqual(['b']);
  });

  it('removes a character only on unanimous junk, after escalation', () => {
    const strict = new Set(['a', 'b']);
    const first = [sample({ a: 'junk', b: 'junk' }), sample({ a: 'junk', b: 'junk' }), sample({ a: 'junk', b: 'minor' })];
    const round = tallyRoleVotes(keys, first, strict);
    expect(round.removed.size).toBe(0);
    expect([...round.escalate]).toEqual(['a']);
    const extra = new Map([['a', [sample({ a: 'junk' }), sample({ a: 'keep' })]]]);
    expect(tallyRoleVotes(keys, first, strict, extra).removed.size).toBe(0);
    const unanimous = new Map([['a', [sample({ a: 'junk' }), sample({ a: 'junk' })]]]);
    expect([...tallyRoleVotes(keys, first, strict, unanimous).removed]).toEqual(['a']);
  });

  it('counts a failed or missing answer as not junk', () => {
    expect([...tallyRoleVotes(keys, [sample({ a: 'junk', b: 'junk' }), null, sample({ b: 'junk' })]).escalate]).toEqual(['b']);
    expect(tallyRoleVotes(keys, [sample({ a: 'junk' }), null, null]).removed.size).toBe(0);
    expect(tallyRoleVotes(keys, [sample({ a: 'junk' }), null, null]).escalate.size).toBe(0);
  });
});

describe('withoutNoRole', () => {
  it('keeps ids and order and gives the next eligible entry the freed importance slot', () => {
    const sentences: Sentence[] = Array.from({ length: 6 }, (_, index) => ({
      ordinal: index + 1,
      spineIndex: index,
      paragraphIndex: 0,
      href: 'invented.xhtml',
      text: 'They waited at dusk.',
      structure: 'body',
      heading: false,
      emphasis: [],
    }));
    const cast = Array.from({ length: 49 }, (_, index) =>
      entity(`e${index}`, 'object', [1, 2, 3, 4, 5, 6], { name: 'glimmerstone', first: index + 1 }),
    ).reverse();
    rankImportance(cast, sentences);
    expect(cast[0].importance).toBe(3);
    expect(withoutNoRole(cast, new Set(), sentences)).toBe(cast);
    const kept = withoutNoRole(cast, new Set(['e0', 'absent']), sentences);
    expect(kept.map(({ id }) => id)).toEqual(cast.slice(0, -1).map(({ id }) => id));
    expect(kept[0].importance).toBe(2);
  });
});
