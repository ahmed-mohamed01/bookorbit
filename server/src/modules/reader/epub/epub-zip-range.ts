import { open } from 'fs/promises';
import type * as unzipper from 'unzipper';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_LENGTH = 30;
const LOCAL_FILE_NAME_LENGTH_OFFSET = 26;
const LOCAL_EXTRA_FIELD_LENGTH_OFFSET = 28;
const COMPRESSION_STORED = 0;
const FLAG_ENCRYPTED = 0x1;

export interface ByteRange {
  start: number;
  end: number;
}

// Audio in read-along EPUBs is stored uncompressed, so its bytes sit
// contiguously in the archive and any range can be read without extracting
// the entry. Null means the entry is compressed or encrypted.
export async function storedZipEntryDataOffset(archivePath: string, entry: unzipper.File): Promise<number | null> {
  if (entry.compressionMethod !== COMPRESSION_STORED || entry.flags & FLAG_ENCRYPTED) return null;
  if (entry.compressedSize !== entry.uncompressedSize) return null;

  const handle = await open(archivePath, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(LOCAL_FILE_HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, LOCAL_FILE_HEADER_LENGTH, entry.offsetToLocalFileHeader);
    if (bytesRead !== LOCAL_FILE_HEADER_LENGTH) return null;
  } finally {
    await handle.close();
  }
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) return null;

  return (
    entry.offsetToLocalFileHeader +
    LOCAL_FILE_HEADER_LENGTH +
    header.readUInt16LE(LOCAL_FILE_NAME_LENGTH_OFFSET) +
    header.readUInt16LE(LOCAL_EXTRA_FIELD_LENGTH_OFFSET)
  );
}
