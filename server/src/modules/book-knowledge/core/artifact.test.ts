import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactCache, ArtifactTooLargeError, artifactJsonBytes, readArtifact, visibleTerms, writeArtifact, writeGzipJsonAtomic } from './artifact';
import type { Artifact } from './model';
import { ARTIFACT_VERSION, TERMS_VERSION, TEXT_VERSION } from './versions';

const MB = 1024 * 1024;
const artifact = (sentenceCount = 1, formatVersion = ARTIFACT_VERSION): Artifact => ({
  formatVersion,
  textVersion: TEXT_VERSION,
  termsVersion: TERMS_VERSION,
  fingerprint: 'a'.repeat(64),
  seeds: [],
  aliasLinks: [],
  terms: [],
  sentences: Array.from({ length: sentenceCount }, (_, index) => ({
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: index,
    href: 'one.xhtml',
    text: 'The lantern hums.',
    structure: 'body',
    heading: false,
    emphasis: [],
  })),
});

describe('artifact storage limits', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'knowledge-artifact-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses to write an artifact above the cap and leaves no file', async () => {
    const path = join(directory, 'artifact.json.gz');
    await expect(writeArtifact(path, artifact(50), 1000)).rejects.toBeInstanceOf(ArtifactTooLargeError);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports the JSON size it wrote and records the size it read', async () => {
    const path = join(directory, 'artifact.json.gz');
    const value = artifact(3);
    const bytes = await writeArtifact(path, value);
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(await writeGzipJsonAtomic(join(directory, 'other.json.gz'), { ok: true })).toBe(11);
    expect(artifactJsonBytes(await readArtifact(path))).toBe(bytes);
  });

  it('rejects an artifact from an older format, version 1 included', async () => {
    const path = join(directory, 'artifact.json.gz');
    for (const version of [1, ARTIFACT_VERSION - 1]) {
      await writeGzipJsonAtomic(path, artifact(1, version));
      await expect(readArtifact(path)).rejects.toThrow('Unsupported artifact');
    }
  });
});

describe('artifact cache', () => {
  it('keeps parsed artifacts within a byte budget', () => {
    const cache = new ArtifactCache();
    const [a, b] = [artifact(), artifact()];
    cache.set('a', a, 200 * MB);
    cache.set('b', b, 200 * MB);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(b);
  });

  it('always keeps the newest artifact, even one over the whole budget', () => {
    const cache = new ArtifactCache();
    const big = artifact();
    cache.set('small', artifact(), 1 * MB);
    cache.set('big', big, 400 * MB);
    expect(cache.get('small')).toBeUndefined();
    expect(cache.get('big')).toBe(big);
  });

  it('evicts the least recently used entry first', () => {
    const cache = new ArtifactCache();
    const [a, b, c] = [artifact(), artifact(), artifact()];
    cache.set('a', a, 100 * MB);
    cache.set('b', b, 100 * MB);
    cache.get('a');
    cache.set('c', c, 150 * MB);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a);
    expect(cache.get('c')).toBe(c);
  });
});

describe('visibility cache', () => {
  it('keeps only two cuts for a very long book', () => {
    const long = artifact(20_001);
    const first = visibleTerms(long, 1);
    visibleTerms(long, 2);
    expect(visibleTerms(long, 1)).toBe(first);
    visibleTerms(long, 3);
    visibleTerms(long, 4);
    expect(visibleTerms(long, 1)).not.toBe(first);
  });
});
