import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Artifact, Mention, Sentence, Term, VisibleTerm } from './model';
import { wordRarity } from './common-words';
import { ARTIFACT_VERSION } from './versions';
import { shortFormLike } from './abbreviations';
import { bookIndex } from './book-index';
import { relatedTerms } from './often-with';

export function deltaEncode(ordinals: number[]): number[] {
  let previous = 0;
  return ordinals.map((ordinal) => {
    if (!Number.isSafeInteger(ordinal) || ordinal < previous) throw new Error('Invalid occurrence order');
    const delta = ordinal - previous;
    previous = ordinal;
    return delta;
  });
}
export function deltaDecode(deltas: number[], cutoff = Infinity): number[] {
  if (Number.isNaN(cutoff)) return [];
  let ordinal = 0;
  const result: number[] = [];
  for (const delta of deltas) {
    if (!Number.isSafeInteger(delta) || delta < 0) throw new Error('Invalid occurrence delta');
    ordinal += delta;
    if (ordinal > cutoff) break;
    result.push(ordinal);
  }
  return result;
}
export function mentionsAt(term: Term, cutoff: number): Mention[] {
  return deltaDecode(term.deltas, cutoff).map((ordinal, index) => ({ ...term.features[index], ordinal }));
}

function classify(mentions: Mention[], person: number, place: number): VisibleTerm['type'] {
  const capital = mentions.filter((m) => /^\p{Lu}/u.test(m.alias)).length / mentions.length;
  const mid = mentions.filter((m) => m.capitalized || m.lowercase);
  const upperMid = mid.filter((m) => m.capitalized).length;
  const words = mentions[0].alias.toLowerCase().split(' ');
  const common = words.every((word) => wordRarity(word) <= 0.1);
  const minimum = common ? (words.length > 1 ? 2 : 3) : 1;
  if (capital < 0.5 && Math.max(person, place) / mentions.length < 0.6) return 'concept';
  if (mid.length && upperMid / mid.length < 0.5 && Math.max(person, place) / mentions.length < 0.6) return 'concept';
  const share = common ? 0.25 : 0.015;
  if (person >= minimum && person / mentions.length >= share && person * 2 >= place) return 'person';
  return place >= Math.max(2, minimum) && place / mentions.length >= (common ? 0.35 : 0.03) && place > person * 2 ? 'place' : 'concept';
}
const visibilityCache = new WeakMap<Artifact, Map<number, VisibleTerm[]>>();
export function visibleTerms(artifact: Artifact, cutoff: number): VisibleTerm[] {
  let cache = visibilityCache.get(artifact);
  if (!cache) {
    cache = new Map();
    visibilityCache.set(artifact, cache);
  }
  const cached = cache.get(cutoff);
  if (cached) return cached;
  const result = computeVisibleTerms(artifact, cutoff);
  for (const term of result) {
    term.mentions.forEach(Object.freeze);
    Object.freeze(term.mentions);
    Object.freeze(term.aliases);
    Object.freeze(term);
  }
  Object.freeze(result);
  cache.set(cutoff, result);
  // Each cut of a very long book holds its own frozen mention arrays, so few are worth keeping.
  if (cache.size > (artifact.sentences.length > 20_000 ? 2 : 8)) cache.delete(cache.keys().next().value!);
  return result;
}
function computeVisibleTerms(artifact: Artifact, cutoff: number): VisibleTerm[] {
  if (!(cutoff >= 1)) return [];
  const visible = new Map<string, VisibleTerm>();
  const roots = new Map<string, string>();
  const index = bookIndex(artifact);
  for (const term of artifact.terms) {
    // The full-book trie can find a mention before the term has a candidate-forming use.
    if (term.candidateOrdinal !== undefined && term.candidateOrdinal > cutoff) continue;
    const uses = mentionsAt(term, cutoff);
    const hasDefinition = uses.some((mention) => mention.definition && !mention.nested);
    if (term.wordCount === 1 && !hasDefinition && uses.filter((mention) => mention.noun === false).length > uses.length / 2) continue;
    const accepted = uses.filter((mention) => term.wordCount > 1 || hasDefinition || mention.noun !== false);
    const recurrence = new Map<string, number>();
    for (const mention of accepted) recurrence.set(mention.alias.toLowerCase(), (recurrence.get(mention.alias.toLowerCase()) ?? 0) + 1);
    const defined = accepted.some((mention) => mention.definition);
    if (
      !defined &&
      /\b(?:fuck|fucking|shit|damn|bloody|hell|yeah|okay|alright|well|hey|oh|huh|um|uh)\b/i.test(term.key) &&
      !accepted.some((m) => m.capitalized)
    )
      continue;
    const mentions = accepted.filter((mention) => !mention.forgiven || defined || (recurrence.get(mention.alias.toLowerCase()) ?? 0) >= 3);
    if (!mentions.length || term.key.length <= 1) continue;
    if (/^(chapter|box|table|figure)$/.test(term.key) && mentions.filter((m) => m.structural).length / mentions.length >= 0.5) continue;
    if (
      !defined &&
      !index.has(term.key) &&
      !mentions.some((m) => m.person || (term.wordCount > 1 && m.place)) &&
      term.key.split(/[\s-]+/).every((word) => wordRarity(word) === 0) &&
      !(term.wordCount > 1 && mentions.length >= 5 && new Set(mentions.map((m) => artifact.sentences[m.ordinal - 1].spineIndex)).size >= 2)
    )
      continue;
    if (
      term.wordCount === 1 &&
      term.key.length <= 3 &&
      mentions.length >= 12 &&
      mentions.filter((mention) => mention.lowercase).length / mentions.length > 0.95 &&
      !mentions.some((mention) => mention.determiner)
    )
      continue;
    const person = mentions.filter((mention) => mention.person).length;
    const place = mentions.filter((mention) => mention.place).length;
    visible.set(term.key, {
      key: term.key,
      displayName: term.key,
      mentions,
      aliases: [...new Set(mentions.map((mention) => mention.alias))],
      first: mentions[0].ordinal,
      latest: mentions.at(-1)!.ordinal,
      count: mentions.length,
      rarity: term.rarity,
      wordCount: term.wordCount,
      type: classify(mentions, person, place),
    });
    roots.set(term.key, term.key);
  }
  const root = (key: string): string => {
    let result = key;
    while (roots.get(result) !== result) result = roots.get(result)!;
    return result;
  };
  for (const link of artifact.aliasLinks) {
    if (
      link.ordinal > cutoff ||
      (link.untilOrdinal !== undefined && link.untilOrdinal <= cutoff) ||
      !visible.has(link.left) ||
      !visible.has(link.right)
    )
      continue;
    const left = root(link.left);
    const right = root(link.right);
    if (left === right) continue;
    const a = visible.get(left)!;
    const b = visible.get(right)!;
    roots.set(
      a.first < b.first || (a.first === b.first && left < right) ? right : left,
      a.first < b.first || (a.first === b.first && left < right) ? left : right,
    );
  }
  const groups = new Map<string, VisibleTerm>();
  for (const term of visible.values()) {
    const key = root(term.key);
    const target = groups.get(key);
    if (!target) groups.set(key, { ...visible.get(key)!, mentions: [...term.mentions], aliases: [...term.aliases] });
    else {
      target.mentions.push(...term.mentions);
      target.aliases.push(...term.aliases);
    }
  }
  return [...groups.values()].map((term) => {
    term.mentions.sort((a, b) => a.ordinal - b.ordinal);
    const spellings = new Map<string, number>();
    for (const mention of term.mentions) {
      const sentence = artifact.sentences[mention.ordinal - 1]?.text ?? '';
      const at = sentence.toLowerCase().indexOf(mention.alias.toLowerCase());
      // An opening quote or dash still leaves the word capitalised as the sentence's first.
      if (at > 0 && /\p{L}/u.test(sentence.slice(0, at))) spellings.set(mention.alias, (spellings.get(mention.alias) ?? 0) + 1);
    }
    const ranked = [...spellings].sort((a, b) => b[1] - a[1]).map(([spelling]) => spelling);
    // A card for "CEV" reads better under its long form, even when the book mostly abbreviates it.
    term.displayName =
      displaySpelling(
        spellings,
        ranked.filter((spelling) => !shortFormLike(spelling)),
      ) ??
      ranked[0] ??
      term.key;
    term.aliases = [
      ...new Map(
        term.aliases.filter((alias) => alias.toLowerCase() !== term.displayName.toLowerCase()).map((alias) => [alias.toLowerCase(), alias]),
      ).values(),
    ];
    term.type = classify(term.mentions, term.mentions.filter((m) => m.person).length, term.mentions.filter((m) => m.place).length);
    term.count = term.mentions.length;
    term.first = term.mentions[0].ordinal;
    term.latest = term.mentions.at(-1)!.ordinal;
    return term;
  });
}
export function visibleTerm(artifact: Artifact, key: string, cutoff: number): VisibleTerm | undefined {
  const own = artifact.terms.find((term) => term.key === key);
  const mentions = own && mentionsAt(own, cutoff);
  if (!mentions?.length) return undefined;
  return visibleTerms(artifact, cutoff).find(
    (term) => term.key === key || term.mentions.some((mention) => mention.ordinal === mentions[0].ordinal && mention.alias === mentions[0].alias),
  );
}
export function activeAliases(artifact: Artifact, key: string, cutoff: number): string[] {
  return visibleTerm(artifact, key, cutoff)?.aliases ?? [];
}
export function latestOccurrence(artifact: Artifact, key: string, cutoff: number): Sentence | undefined {
  const ordinal = visibleTerm(artifact, key, cutoff)?.latest;
  return ordinal === undefined ? undefined : artifact.sentences[ordinal - 1];
}
export function histogram(artifact: Artifact, key: string, cutoff: number): { spineIndex: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const mention of visibleTerm(artifact, key, cutoff)?.mentions ?? []) {
    const chapter = artifact.sentences[mention.ordinal - 1].spineIndex;
    counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
  }
  return [...counts].map(([spineIndex, count]) => ({ spineIndex, count }));
}
export function oftenWith(
  artifact: Artifact,
  key: string,
  cutoff: number,
  ...[, limit = 10]: [window?: number, limit?: number]
): { key: string; displayName: string; count: number; first: number }[] {
  const selected = visibleTerm(artifact, key, cutoff);
  return selected ? relatedTerms(artifact, selected, visibleTerms(artifact, cutoff), cutoff, limit) : [];
}

export function artifactPath(appDataPath: string, bookId: number, fingerprint: string): string {
  if (!Number.isSafeInteger(bookId) || bookId < 1 || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid artifact identity');
  return join(resolve(appDataPath), 'book-knowledge', String(bookId), fingerprint, 'artifact.json.gz');
}
export const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const ARTIFACT_TOO_LARGE_MESSAGE = 'Artifact exceeds size limit';
export class ArtifactTooLargeError extends Error {
  constructor() {
    super(ARTIFACT_TOO_LARGE_MESSAGE);
    this.name = 'ArtifactTooLargeError';
  }
}
/** Writes gzipped JSON atomically and returns the JSON size in bytes. */
export async function writeGzipJsonAtomic(path: string, value: unknown, maxBytes = Infinity): Promise<number> {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    // V8 cannot hold a string past its length limit, so a too-large value fails here before the byte check.
    if (error instanceof RangeError) throw new ArtifactTooLargeError();
    throw error;
  }
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) throw new ArtifactTooLargeError();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await pipeline(Readable.from([json]), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}
async function readGzipJsonSized<T>(path: string, maxBytes: number): Promise<{ value: T; bytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const source = createReadStream(path);
  const stream = source.pipe(createGunzip());
  source.on('error', (error) => stream.destroy(error));
  stream.once('close', () => source.destroy());
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      source.destroy();
      stream.destroy();
      throw new Error('Artifact exceeds read limit');
    }
    chunks.push(chunk);
  }
  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T, bytes: size };
}
export async function readGzipJson<T>(path: string, maxBytes = 128 * 1024 * 1024): Promise<T> {
  return (await readGzipJsonSized<T>(path, maxBytes)).value;
}
const loadedBytes = new WeakMap<Artifact, number>();
/** The JSON size an artifact was read from, the cache's stand-in for its parsed memory. */
export function artifactJsonBytes(artifact: Artifact): number | undefined {
  return loadedBytes.get(artifact);
}
export const writeArtifact = (path: string, artifact: Artifact, maxBytes = ARTIFACT_MAX_BYTES): Promise<number> =>
  writeGzipJsonAtomic(path, artifact, maxBytes);
export async function readArtifact(path: string, maxBytes = ARTIFACT_MAX_BYTES): Promise<Artifact> {
  const { value: artifact, bytes } = await readGzipJsonSized<Artifact>(path, maxBytes);
  if (
    artifact.formatVersion !== ARTIFACT_VERSION ||
    !Array.isArray(artifact.sentences) ||
    !Array.isArray(artifact.terms) ||
    !Array.isArray(artifact.aliasLinks) ||
    (artifact.modelVotes !== undefined && !Array.isArray(artifact.modelVotes)) ||
    (artifact.spineBytes !== undefined && !Array.isArray(artifact.spineBytes))
  )
    throw new Error('Unsupported artifact');
  loadedBytes.set(artifact, bytes);
  return artifact;
}
const ARTIFACT_CACHE_BYTES = 300 * 1024 * 1024;
export class ArtifactCache {
  private readonly entries = new Map<string, { value: Artifact; bytes: number }>();
  private bytes = 0;
  get(key: string): Artifact | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }
  set(key: string, value: Artifact, bytes = artifactJsonBytes(value) ?? 0): void {
    this.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > ARTIFACT_CACHE_BYTES && this.entries.size > 1) this.delete(this.entries.keys().next().value!);
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

const TITLE_SMALL_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'to', 'a', 'an', 'for', 'at']);

/** Shouted ("IMPERIAL FAMILY") or glitched ("ImperIaL") casing: a long all-caps word, or more than one capital inside a word. */
function oddlyCased(spelling: string): boolean {
  return spelling
    .split(/\s+/)
    .some((word) => /^[\p{Lu}\p{N}'’-]{5,}$/u.test(word) || (word.slice(1).match(/\p{Lu}/gu) ?? []).length > 1 || /\p{Ll}\p{Lu}$/u.test(word));
}

function titleCase(spelling: string): string {
  return spelling
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => (index > 0 && TITLE_SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * The name a card shows: the commonest plainly cased spelling. When the book only ever capitalises it in shouted
 * or glitched forms, the plain lowercase spelling is title-cased instead, as a reader would write the name.
 */
export function displaySpelling(counts: ReadonlyMap<string, number>, ranked: readonly string[]): string | undefined {
  if (!ranked.length) return undefined;
  const plain = ranked.filter((spelling) => !oddlyCased(spelling));
  const best = plain[0];
  if (best === undefined) return titleCase(ranked[0]);
  if (best !== best.toLowerCase()) return best;
  const capitalised = ranked.filter((spelling) => oddlyCased(spelling)).reduce((sum, spelling) => sum + (counts.get(spelling) ?? 0), 0);
  return capitalised >= (counts.get(best) ?? 0) ? titleCase(best) : best;
}
