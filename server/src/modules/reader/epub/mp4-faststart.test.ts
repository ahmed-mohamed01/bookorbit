import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as unzipper from 'unzipper';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStream } from '../../../common/test-utils/read-stream';
import { mp4Box, mp4ChunkOffsets, mp4Index, writeZipFixture } from '../../../common/test-utils/zip-fixture';
import { storedZipEntryDataOffset } from './epub-zip-range';
import { buildFaststartLayout, shiftChunkOffsets, storedLayout, streamLayoutRange } from './mp4-faststart';

const FTYP = mp4Box('ftyp', Buffer.from('isom\0\0\0\0'));
const SAMPLES = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 251));
const MDAT = mp4Box('mdat', SAMPLES);
const CHUNK_OFFSETS = [FTYP.length + 8, FTYP.length + 108, FTYP.length + 208];

function readChunkOffsets(file: Buffer): number[] {
  const at = file.indexOf('stco', 0, 'latin1') + 4;
  const count = file.readUInt32BE(at + 4);
  return Array.from({ length: count }, (_, i) => file.readUInt32BE(at + 8 + i * 4));
}

describe('mp4 faststart layout', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookorbit-faststart-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function storeInZip(mp4: Buffer) {
    const path = join(root, 'book.epub');
    await writeZipFixture(path, [
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'Audio/chapter.mp4', data: mp4, store: true },
    ]);
    const zip = await unzipper.Open.file(path);
    const entry = zip.files.find((file) => file.path === 'Audio/chapter.mp4')!;
    return { path, dataStart: (await storedZipEntryDataOffset(path, entry))!, size: mp4.length };
  }

  it('serves the index first with chunk offsets moved past it', async () => {
    const moov = mp4Index(mp4ChunkOffsets(CHUNK_OFFSETS));
    const { path, dataStart, size } = await storeInZip(Buffer.concat([FTYP, MDAT, moov]));

    const layout = await buildFaststartLayout(path, dataStart, size);
    const file = await readStream(streamLayoutRange(path, dataStart, layout!, { start: 0, end: size - 1 }));

    expect(file.length).toBe(size);
    expect(layout!.indexBytes).toBe(moov.length);
    expect(file.toString('latin1', FTYP.length + 4, FTYP.length + 8)).toBe('moov');
    const offsets = readChunkOffsets(file);
    expect(offsets).toEqual(CHUNK_OFFSETS.map((offset) => offset + moov.length));
    expect(file.subarray(offsets[0], offsets[0] + 100)).toEqual(SAMPLES.subarray(0, 100));
  });

  it('serves any byte range of the rearranged file', async () => {
    const { path, dataStart, size } = await storeInZip(Buffer.concat([FTYP, MDAT, mp4Index(mp4ChunkOffsets(CHUNK_OFFSETS))]));
    const layout = (await buildFaststartLayout(path, dataStart, size))!;
    const whole = await readStream(streamLayoutRange(path, dataStart, layout, { start: 0, end: size - 1 }));

    for (const [start, end] of [
      [0, 10],
      [FTYP.length - 3, FTYP.length + 20],
      [size - 50, size - 1],
      [40, 300],
    ] as const) {
      await expect(readStream(streamLayoutRange(path, dataStart, layout, { start, end }))).resolves.toEqual(whole.subarray(start, end + 1));
    }
  });

  it('serves the stored layout unchanged and handles an empty range', async () => {
    const mp4 = Buffer.concat([FTYP, MDAT]);
    const { path, dataStart, size } = await storeInZip(mp4);

    await expect(readStream(streamLayoutRange(path, dataStart, storedLayout(size), { start: 5, end: 40 }))).resolves.toEqual(mp4.subarray(5, 41));
    await expect(readStream(streamLayoutRange(path, dataStart, storedLayout(0), { start: 0, end: -1 }))).resolves.toEqual(Buffer.alloc(0));
  });

  it('leaves files that already start with their index alone', async () => {
    const { path, dataStart, size } = await storeInZip(Buffer.concat([FTYP, mp4Index(mp4ChunkOffsets(CHUNK_OFFSETS)), MDAT]));

    await expect(buildFaststartLayout(path, dataStart, size)).resolves.toBeNull();
  });

  describe('shiftChunkOffsets', () => {
    const region = { start: 100, end: 1000, shift: 50 };

    it('shifts only offsets into the moved data', () => {
      const moov = mp4Index(mp4ChunkOffsets([20, 100, 999, 1000, 5000]));

      expect(shiftChunkOffsets(moov, region)).toBe(true);
      expect(readChunkOffsets(moov)).toEqual([20, 150, 1049, 1000, 5000]);
    });

    it('shifts 64-bit chunk offsets', () => {
      const moov = mp4Index(mp4ChunkOffsets([2 ** 40], true));

      expect(shiftChunkOffsets(moov, { start: 0, end: 2 ** 41, shift: 1000 })).toBe(true);
      expect(moov.readBigUInt64BE(moov.indexOf('co64', 0, 'latin1') + 12)).toBe(BigInt(2 ** 40 + 1000));
    });

    it('refuses a shift that would overflow a 32-bit chunk offset', () => {
      expect(shiftChunkOffsets(mp4Index(mp4ChunkOffsets([0xffffff00])), { start: 0, end: 2 ** 33, shift: 0x1000 })).toBe(false);
    });

    it('refuses an index with item locations it would not rewrite', () => {
      const meta = mp4Box('meta', Buffer.alloc(4), mp4Box('iloc', Buffer.alloc(8)));

      expect(shiftChunkOffsets(mp4Index(mp4ChunkOffsets([200]), mp4Box('udta', meta)), region)).toBe(false);
    });

    it('refuses a malformed index', () => {
      const moov = mp4Index(mp4ChunkOffsets(CHUNK_OFFSETS));
      moov.writeUInt32BE(10_000, 8);

      expect(shiftChunkOffsets(moov, region)).toBe(false);
    });
  });
});
