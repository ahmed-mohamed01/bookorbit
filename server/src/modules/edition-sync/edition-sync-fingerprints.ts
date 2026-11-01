import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { load, type CheerioAPI } from 'cheerio';
import * as unzipper from 'unzipper';

// Large audiobooks on slow disks take minutes to read, so the limit grows with the file (about 10 MB/s).
export function fingerprintTimeoutMs(sizeBytes: number): number {
  return Math.max(120_000, Math.ceil(sizeBytes / 10_000));
}

export async function audioFingerprint(path: string, ffmpegPath: string): Promise<string> {
  const timeoutMs = fingerprintTimeoutMs((await stat(path)).size);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-i', path, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], {
      signal: AbortSignal.timeout(timeoutMs),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      if (output.length > 1024) child.kill();
    });
    child.once('error', () => reject(new InternalServerErrorException('Audio fingerprint failed')));
    child.once('close', (code) => {
      const match = /^MD5=([a-fA-F0-9]{32})\s*$/.exec(output.trim());
      if (code !== 0 || !match) reject(new InternalServerErrorException('Invalid audio fingerprint output'));
      else resolve(match[1].toLowerCase());
    });
  });
}

const local = (xml: CheerioAPI, name: string) => xml('*').filter((_, element) => 'name' in element && element.name.split(':').pop() === name);

export async function chapterFingerprint(path: string): Promise<string> {
  const zip = await unzipper.Open.file(path);
  const entries = new Map(zip.files.map((entry) => [entry.path, entry]));
  const read = async (name: string) => {
    const entry = entries.get(name);
    if (!entry || entry.uncompressedSize > 16 * 1024 * 1024) throw new BadRequestException('Invalid EPUB document');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const bytes of entry.stream()) {
      size += (bytes as Buffer).length;
      if (size > 16 * 1024 * 1024) throw new BadRequestException('Invalid EPUB document');
      chunks.push(bytes as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    return { document: load(bytes, { xml: true }), bytes };
  };
  const { document: container } = await read('META-INF/container.xml');
  const opfPath = local(container, 'rootfile').first().attr('full-path');
  if (!opfPath) throw new BadRequestException('Missing EPUB package');
  const { document: opf } = await read(opfPath);
  const manifest = new Map(
    local(opf, 'item')
      .toArray()
      .map((item) => [opf(item).attr('id'), opf(item).attr('href')]),
  );
  const hash = createHash('sha256');
  for (const item of local(opf, 'itemref').toArray()) {
    const href = manifest.get(opf(item).attr('idref'));
    if (!href) throw new BadRequestException('Missing EPUB spine document');
    const { document, bytes } = await read(posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(href))));
    if (!local(document, 'body').length) throw new BadRequestException('Missing EPUB body');
    const hasText = local(document, 'body').text().replace(/\s+/gu, ' ').trim().length > 0;
    hash.update(JSON.stringify([href, hasText ? createHash('sha256').update(bytes).digest('hex') : '']) + '\n');
  }
  if (!local(opf, 'itemref').length) throw new BadRequestException('Empty EPUB spine');
  return hash.digest('hex');
}
