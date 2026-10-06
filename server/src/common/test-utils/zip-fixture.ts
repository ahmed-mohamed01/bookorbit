import { writeFile } from 'fs/promises';
import { ZipArchive } from 'archiver';

export interface ZipFixtureEntry {
  name: string;
  data: Buffer | string;
  store?: boolean;
}

export async function writeZipFixture(path: string, entries: ZipFixtureEntry[]): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const { name, data, store } of entries) archive.append(data, { name, store: store ?? false });
  await archive.finalize();
  await done;
  await writeFile(path, Buffer.concat(chunks));
}

export function mp4Box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

export function mp4ChunkOffsets(offsets: number[], wide = false): Buffer {
  const width = wide ? 8 : 4;
  const body = Buffer.alloc(8 + offsets.length * width);
  body.writeUInt32BE(offsets.length, 4);
  offsets.forEach((offset, i) => {
    if (wide) body.writeBigUInt64BE(BigInt(offset), 8 + i * 8);
    else body.writeUInt32BE(offset, 8 + i * 4);
  });
  return mp4Box(wide ? 'co64' : 'stco', body);
}

export function mp4Index(chunkOffsets: Buffer, ...extra: Buffer[]): Buffer {
  return mp4Box('moov', mp4Box('mvhd', Buffer.alloc(12)), mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', chunkOffsets)))), ...extra);
}
