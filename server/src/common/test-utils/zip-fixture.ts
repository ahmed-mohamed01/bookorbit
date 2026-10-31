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
