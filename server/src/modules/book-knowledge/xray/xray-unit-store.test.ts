import { Logger } from '@nestjs/common';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Sentence } from '../core/model';
import { XrayPrivacy, XrayStepRun } from './xray-runner';
import { replayable, requestHash, XrayUnitStore } from './xray-unit-store';

const scope = { fingerprint: 'f'.repeat(64), promptVersion: 9, model: 'gpt-oss-20b' };
const sentences: Sentence[] = [
  { text: 'Viv walked.', ordinal: 1, spineIndex: 0, paragraphIndex: 0, href: 'a.xhtml', structure: 'body', heading: false, emphasis: [] },
];

describe('stored X-Ray answers', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bk-units-'));
    path = join(dir, 'book', 'xray-units.jsonl.gz');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replays a saved answer for the same request, scope and unit, and not for another', async () => {
    const first = new XrayUnitStore(path, scope);
    expect(await first.load()).toBe(0);
    first.save('notes', 'u1c1', 'h1', { notes: {} }, { 'notes:missing': 1 });
    first.save('facts', 'u1c1', 'h2', { identity: [] }, {});
    await first.flush();
    const again = new XrayUnitStore(path, scope);
    expect(await again.load()).toBe(2);
    expect(again.answer('notes', 'u1c1', 'h1')).toEqual({ notes: {} });
    expect(again.answer('notes', 'u1c2', 'h1')).toBeUndefined();
    expect(again.answer('notes', 'u1c1', 'other')).toBeUndefined();
    const otherModel = new XrayUnitStore(path, { ...scope, model: 'other' });
    expect(await otherModel.load()).toBe(0);
    expect(otherModel.stale).toBe(2);
  });

  it('ignores a corrupt line and a cut last member', async () => {
    const store = new XrayUnitStore(path, scope);
    store.save('notes', 'u1c1', 'h1', { ok: true }, {});
    await store.flush();
    await appendFile(path, gzipSync('not json\n'));
    const cut = gzipSync(`${JSON.stringify({ ...scope, step: 'notes', unit: 'u2c1', request: 'h3', answer: {}, rejected: {} })}\n`);
    await appendFile(path, cut.subarray(0, cut.length - 12));
    const loaded = new XrayUnitStore(path, scope);
    expect(await loaded.load()).toBe(1);
    expect(loaded.answer('notes', 'u1c1', 'h1')).toEqual({ ok: true });
    expect(loaded.damaged).toBe(true);
    loaded.save('notes', 'u3c1', 'h4', { after: true }, {});
    await loaded.flush();
    const reread = new XrayUnitStore(path, scope);
    expect(await reread.load()).toBe(2);
    expect(reread.answer('notes', 'u1c1', 'h1')).toEqual({ ok: true });
    expect(reread.answer('notes', 'u3c1', 'h4')).toEqual({ after: true });
    expect(reread.damaged).toBe(false);
  });

  it('stores nothing once closed, so a cancelled build cannot write into the next one', async () => {
    const store = new XrayUnitStore(path, scope);
    store.save('notes', 'u1c1', 'h1', { kept: true }, {});
    store.close();
    store.save('notes', 'u1c2', 'h2', { late: true }, {});
    await store.flush();
    const reread = new XrayUnitStore(path, scope);
    expect(await reread.load()).toBe(1);
    expect(reread.answer('notes', 'u1c2', 'h2')).toBeUndefined();
  });

  it('starts over on a fresh build', async () => {
    const store = new XrayUnitStore(path, scope);
    store.save('notes', 'u1c1', 'h1', { ok: true }, {});
    await store.flush();
    const fresh = new XrayUnitStore(path, scope);
    await fresh.reset();
    expect(fresh.answer('notes', 'u1c1', 'h1')).toBeUndefined();
    expect(await new XrayUnitStore(path, scope).load()).toBe(0);
  });

  it('drops answers from an older prompt version on the first write', async () => {
    const old = new XrayUnitStore(path, { ...scope, promptVersion: 8 });
    old.save('notes', 'u1c1', 'h1', { old: true }, {});
    await old.flush();
    const current = new XrayUnitStore(path, scope);
    await current.load();
    current.save('notes', 'u1c1', 'h1', { current: true }, {});
    await current.flush();
    const reread = new XrayUnitStore(path, { ...scope, promptVersion: 8 });
    expect(await reread.load()).toBe(0);
    expect(reread.stale).toBe(1);
    const kept = new XrayUnitStore(path, scope);
    expect(await kept.load()).toBe(1);
    expect(kept.answer('notes', 'u1c1', 'h1')).toEqual({ current: true });
  });

  it('keeps a multibyte character whole when it falls across two decoded chunks', async () => {
    // Three-byte characters with a one-byte lead, so no whole number of them fills a stream chunk.
    const text = `x${'漢字の物語'.repeat(30000)}`;
    const store = new XrayUnitStore(path, scope);
    store.save('notes', 'u1c1', 'h1', { text }, {});
    store.save('notes', 'u1c2', 'h2', { text: 'ünïcödé' }, {});
    await store.flush();
    const loaded = new XrayUnitStore(path, scope);
    expect(await loaded.load()).toBe(2);
    expect(loaded.answer('notes', 'u1c1', 'h1')).toEqual({ text });
    expect(loaded.answer('notes', 'u1c2', 'h2')).toEqual({ text: 'ünïcödé' });
  });

  it('answers a step unit from the store without sending, and stores a sent answer', async () => {
    const store = new XrayUnitStore(path, scope);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('notes', 'fast', new XrayPrivacy(sentences), logger, 'runId=r', store);
    const request = { system: 's', user: 'u', maxOutputTokens: 10 };
    const send = vi.fn(() => Promise.resolve({ text: '{"n": 1}', usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' }));
    const read = (value: unknown) => ({ items: value, rejected: { seen: 1 } });
    expect(await step.unit({ id: 'u1', ordinals: [1], send: replayable(send, request), read })).toEqual({ n: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    await store.flush();

    const replayed = new XrayUnitStore(path, scope);
    await replayed.load();
    const later = new XrayStepRun('notes', 'fast', new XrayPrivacy(sentences), logger, 'runId=r', replayed);
    const unsent = vi.fn(() => Promise.reject(new Error('sent')));
    expect(await later.unit({ id: 'u1', ordinals: [1], send: replayable(unsent, request), read })).toEqual({ n: 1 });
    expect(unsent).not.toHaveBeenCalled();
    expect(later.record.counts).toEqual({ replayed: 1 });
    expect(later.record.calls).toBe(0);
    expect(later.record.privacy.sentences).toBe(0);
    expect(later.record.rejected).toEqual({ seen: 1 });
    expect(requestHash(request)).toBe(requestHash({ ...request }));
  });
});
