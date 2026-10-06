import { createReadStream } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { Readable } from 'stream';

import type { ByteRange } from './epub-zip-range';

// Storyteller writes read-along audio with the MP4 index (moov) after the
// audio data (mdat). A browser streaming such a file has to read the start,
// jump to the end for the index and jump back before it can play anything.
// Serving the same file with the index first, the way
// `ffmpeg -movflags +faststart` would write it, saves those round trips
// without touching the file: only the index is rewritten, in memory.

const BOX_HEADER_LENGTH = 8;
const LARGE_BOX_HEADER_LENGTH = 16;
const FULL_BOX_VERSION_LENGTH = 4;
// Per-chapter read-along indexes are a few hundred KB; anything far larger is
// not worth holding in memory.
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_UINT32 = 0xffffffff;
const INDEX_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta']);

interface Box {
  type: string;
  start: number;
  size: number;
}

type Segment = { virtualStart: number; length: number } & ({ data: Buffer } | { sourceStart: number });

export interface StoredMediaLayout {
  size: number;
  segments: Segment[];
  indexBytes: number;
}

interface ShiftedRegion {
  start: number;
  end: number;
  shift: number;
}

async function readTopLevelBoxes(handle: FileHandle, dataStart: number, size: number): Promise<Box[] | null> {
  const boxes: Box[] = [];
  const header = Buffer.alloc(LARGE_BOX_HEADER_LENGTH);
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(header, 0, LARGE_BOX_HEADER_LENGTH, dataStart + offset);
    if (bytesRead < BOX_HEADER_LENGTH) return null;
    let boxSize = header.readUInt32BE(0);
    if (boxSize === 1) {
      if (bytesRead < LARGE_BOX_HEADER_LENGTH) return null;
      boxSize = Number(header.readBigUInt64BE(8));
    } else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < BOX_HEADER_LENGTH || offset + boxSize > size) return null;
    boxes.push({ type: header.toString('latin1', 4, 8), start: offset, size: boxSize });
    offset += boxSize;
  }
  return boxes;
}

// Only offsets into the moved data are shifted: data placed after the index
// keeps its position. Item locations (iloc) are not rewritten, so an index
// that has them is refused rather than served wrong.
export function shiftChunkOffsets(index: Buffer, region: ShiftedRegion, start = 0, end = index.length): boolean {
  for (let pos = start; pos + BOX_HEADER_LENGTH <= end;) {
    let size = index.readUInt32BE(pos);
    const type = index.toString('latin1', pos + 4, pos + 8);
    let headerLength = BOX_HEADER_LENGTH;
    if (size === 1) {
      size = Number(index.readBigUInt64BE(pos + 8));
      headerLength = LARGE_BOX_HEADER_LENGTH;
    } else if (size === 0) size = end - pos;
    if (size < headerLength || pos + size > end) return false;

    if (type === 'iloc') return false;
    if (INDEX_CONTAINERS.has(type)) {
      if (!shiftChunkOffsets(index, region, pos + headerLength, pos + size)) return false;
    } else if (type === 'meta') {
      if (!shiftChunkOffsets(index, region, pos + headerLength + FULL_BOX_VERSION_LENGTH, pos + size)) return false;
    } else if (type === 'stco' || type === 'co64') {
      if (!shiftTable(index, region, type === 'co64', pos + headerLength, pos + size)) return false;
    }
    pos += size;
  }
  return true;
}

function shiftTable(index: Buffer, region: ShiftedRegion, wide: boolean, bodyStart: number, boxEnd: number): boolean {
  const count = index.readUInt32BE(bodyStart + 4);
  const first = bodyStart + 8;
  const width = wide ? 8 : 4;
  if (first + count * width > boxEnd) return false;
  for (let at = first; at < first + count * width; at += width) {
    const offset = wide ? Number(index.readBigUInt64BE(at)) : index.readUInt32BE(at);
    if (offset < region.start || offset >= region.end) continue;
    const shifted = offset + region.shift;
    if (wide) index.writeBigUInt64BE(BigInt(shifted), at);
    else if (shifted > MAX_UINT32) return false;
    else index.writeUInt32BE(shifted, at);
  }
  return true;
}

function layoutOf(size: number, parts: Array<{ data: Buffer } | { sourceStart: number; length: number }>): StoredMediaLayout {
  const segments: Segment[] = [];
  let virtualStart = 0;
  let indexBytes = 0;
  for (const part of parts) {
    const length = 'data' in part ? part.data.length : part.length;
    if (length <= 0) continue;
    if ('data' in part) indexBytes += length;
    segments.push({ ...part, length, virtualStart });
    virtualStart += length;
  }
  return { size, segments, indexBytes };
}

export function storedLayout(size: number): StoredMediaLayout {
  return layoutOf(size, [{ sourceStart: 0, length: size }]);
}

// Null when the file already starts with its index or cannot be rearranged safely.
export async function buildFaststartLayout(archivePath: string, dataStart: number, size: number): Promise<StoredMediaLayout | null> {
  const handle = await open(archivePath, 'r');
  try {
    const boxes = await readTopLevelBoxes(handle, dataStart, size);
    if (!boxes) return null;
    const mdat = boxes.find((box) => box.type === 'mdat');
    const moov = boxes.find((box) => box.type === 'moov');
    if (!mdat || !moov || moov.start < mdat.start || moov.size > MAX_INDEX_BYTES) return null;

    const index = Buffer.alloc(moov.size);
    const { bytesRead } = await handle.read(index, 0, moov.size, dataStart + moov.start);
    if (bytesRead !== moov.size) return null;
    if (!shiftChunkOffsets(index, { start: mdat.start, end: moov.start, shift: moov.size })) return null;

    return layoutOf(size, [
      { sourceStart: 0, length: mdat.start },
      { data: index },
      { sourceStart: mdat.start, length: moov.start - mdat.start },
      { sourceStart: moov.start + moov.size, length: size - moov.start - moov.size },
    ]);
  } finally {
    await handle.close();
  }
}

export function streamLayoutRange(archivePath: string, dataStart: number, layout: StoredMediaLayout, range: ByteRange): NodeJS.ReadableStream {
  async function* chunks() {
    for (const segment of layout.segments) {
      const segmentEnd = segment.virtualStart + segment.length - 1;
      if (segmentEnd < range.start || segment.virtualStart > range.end) continue;
      const from = Math.max(range.start, segment.virtualStart) - segment.virtualStart;
      const to = Math.min(range.end, segmentEnd) - segment.virtualStart;
      if ('data' in segment) {
        yield segment.data.subarray(from, to + 1);
        continue;
      }
      const source = dataStart + segment.sourceStart;
      for await (const chunk of createReadStream(archivePath, { start: source + from, end: source + to })) yield chunk as Buffer;
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}
