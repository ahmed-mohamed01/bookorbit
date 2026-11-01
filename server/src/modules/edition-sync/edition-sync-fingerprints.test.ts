import { InternalServerErrorException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { spawn } from 'node:child_process';
import { audioFingerprint, fingerprintTimeoutMs, chapterFingerprint } from './edition-sync-fingerprints';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const folders: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function epub(title: string, text: string, cover: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-'));
  folders.push(dir);
  const path = join(dir, 'book.epub');
  const zip = new ZipArchive();
  const done = pipeline(zip, createWriteStream(path));
  const entries = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf': `<package><metadata><title>${title}</title></metadata><manifest><item id="cover" href="cover.xhtml"/><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="cover"/><itemref idref="c"/></spine></package>`,
    'OPS/cover.xhtml': `<html><body><img src="${cover}"/></body></html>`,
    'OPS/c.xhtml': `<html><body>${text}</body></html>`,
  };
  for (const [name, value] of Object.entries(entries)) zip.append(value, { name });
  await zip.finalize();
  await done;
  return path;
}
async function audioFile() {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-'));
  folders.push(dir);
  const path = join(dir, 'book.m4b');
  await writeFile(path, 'audio');
  return path;
}
describe('content fingerprints', () => {
  it('ignores metadata and cover bytes but detects chapter markup edits', async () => {
    const original = await chapterFingerprint(await epub('Old', '<p>Hello <b>world</b></p>', 'old.png'));
    expect(await chapterFingerprint(await epub('New', '<p>Hello <b>world</b></p>', 'new.png'))).toBe(original);
    expect(await chapterFingerprint(await epub('New', '<p id="new">Hello <b>world</b></p>', 'new.png'))).not.toBe(original);
    expect(await chapterFingerprint(await epub('New', '<p>Changed world</p>', 'new.png'))).not.toBe(original);
  });
  it('uses configured ffmpeg, packet copy, bounded timeout and parses MD5', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    const path = await audioFile();
    const result = audioFingerprint(path, '/tools/ffmpeg');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.write('MD5=' + 'A'.repeat(32) + '\n');
    child.emit('close', 0);
    await expect(result).resolves.toBe('a'.repeat(32));
    expect(spawn).toHaveBeenCalledWith(
      '/tools/ffmpeg',
      ['-v', 'error', '-i', path, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('scales the ffmpeg timeout with file size', () => {
    expect(fingerprintTimeoutMs(50_000_000)).toBe(120_000);
    expect(fingerprintTimeoutMs(4_000_000_000)).toBe(400_000);
  });
  it.each(['bad output', 'nonzero', 'spawn error'])('fails closed on %s', async (mode) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    const result = audioFingerprint(await audioFile(), 'ffmpeg');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    if (mode === 'spawn error') child.emit('error', new Error('missing'));
    else {
      child.stdout.write(mode === 'bad output' ? 'bad' : 'MD5=' + 'a'.repeat(32));
      child.emit('close', mode === 'nonzero' ? 1 : 0);
    }
    await expect(result).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('shared chapter fingerprint fixtures', () => {
  it('matches the fixed worker parity digests', async () => {
    const fixtures = JSON.parse(
      await readFile(join(__dirname, '../../../..', 'workers/read-aloud/test/fixtures/chapter-fingerprints.json'), 'utf8'),
    ) as Array<{ name: string; entries: Record<string, string>; expected: string }>;
    for (const fixture of fixtures) {
      const dir = await mkdtemp(join(tmpdir(), 'fingerprint-parity-'));
      folders.push(dir);
      const path = join(dir, 'book.epub');
      const zip = new ZipArchive();
      const done = pipeline(zip, createWriteStream(path));
      for (const [name, value] of Object.entries(fixture.entries)) zip.append(value, { name });
      await zip.finalize();
      await done;
      expect(await chapterFingerprint(path), fixture.name).toBe(fixture.expected);
    }
  });
});
