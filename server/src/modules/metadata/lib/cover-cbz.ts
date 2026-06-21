import { readFile } from 'fs/promises';
import { inflateRawSync } from 'zlib';
import { compareArchiveEntryNames, isArchiveImageFile, isHiddenArchivePath } from './archive-image-utils';

interface ZipImageEntry {
  name: string;
  compression: 0 | 8;
  compressedSize: number;
  localHeaderOffset: number;
}

/**
 * Locate the end-of-central-directory record by scanning backwards from the end
 * of the buffer. Handles ZIP comments up to 65535 bytes (e.g. ComicTagger JSON
 * appended to the archive).
 */
function findEOCD(buf: Buffer): { cdOffset: number; cdSize: number } | null {
  const searchStart = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x05 || buf[i + 3] !== 0x06) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen <= buf.length) {
      return { cdOffset: buf.readUInt32LE(i + 16), cdSize: buf.readUInt32LE(i + 12) };
    }
  }
  return null;
}

function isZipBoundsValid(start: number, length: number, totalSize: number): boolean {
  return start >= 0 && length >= 0 && start + length <= totalSize;
}

function readImageEntriesFromCentralDirectory(buf: Buffer): ZipImageEntry[] | null {
  const eocd = findEOCD(buf);
  if (!eocd) return null;

  if (!isZipBoundsValid(eocd.cdOffset, eocd.cdSize, buf.length)) return null;

  const images: ZipImageEntry[] = [];
  const cdEnd = eocd.cdOffset + eocd.cdSize;
  let pos = eocd.cdOffset;

  while (pos + 46 <= cdEnd) {
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x4b || buf[pos + 2] !== 0x01 || buf[pos + 3] !== 0x02) break;

    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const nextPos = pos + 46 + fileNameLen + extraLen + commentLen;

    if (nextPos > cdEnd) return null;

    const fileName = buf.subarray(pos + 46, pos + 46 + fileNameLen).toString('utf-8');

    if (!fileName.endsWith('/') && !isHiddenArchivePath(fileName) && isArchiveImageFile(fileName) && (compression === 0 || compression === 8)) {
      images.push({ name: fileName, compression, compressedSize, localHeaderOffset });
    }

    pos = nextPos;
  }

  return images;
}

function extractImageEntry(buf: Buffer, entry: ZipImageEntry): Buffer | null {
  if (!isZipBoundsValid(entry.localHeaderOffset, 30, buf.length)) return null;
  if (buf[entry.localHeaderOffset] !== 0x50 || buf[entry.localHeaderOffset + 1] !== 0x4b || buf[entry.localHeaderOffset + 2] !== 0x03) return null;
  if (buf[entry.localHeaderOffset + 3] !== 0x04) return null;

  const lfhFileNameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + lfhFileNameLen + lfhExtraLen;

  if (!isZipBoundsValid(dataStart, entry.compressedSize, buf.length)) return null;

  const payload = buf.subarray(dataStart, dataStart + entry.compressedSize);
  return entry.compression === 0 ? payload : inflateRawSync(payload);
}

/**
 * Extract the first naturally-sorted image from a CBZ file using the ZIP central directory.
 *
 * Reading sizes from the central directory (rather than local file headers) is
 * required because many CBZ files use data descriptors — a ZIP feature where the
 * compressed/uncompressed sizes in the local file header are left as zero and the
 * real values appear in a trailing descriptor after the data. The central directory
 * always carries the correct sizes regardless of this flag.
 *
 * Supports STORED (0) and DEFLATE (8) compression.
 */
export async function extractCbzCover(absolutePath: string): Promise<Buffer | null> {
  try {
    const buf = await readFile(absolutePath);
    const images = readImageEntriesFromCentralDirectory(buf);
    if (!images?.length) return null;

    images.sort((a, b) => compareArchiveEntryNames(a.name, b.name));
    for (const image of images) {
      try {
        const extracted = extractImageEntry(buf, image);
        if (extracted) return extracted;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
