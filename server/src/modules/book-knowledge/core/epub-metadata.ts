import * as unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import type { BookMetadata } from './model';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const texts = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['#text'] : item))
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean);

export async function readEpubMetadata(source: string): Promise<BookMetadata> {
  const zip = await unzipper.Open.file(source);
  const read = async (path: string): Promise<string> => {
    const entry = zip.files.find((file) => file.path === path);
    if (!entry || entry.uncompressedSize > 4 * 1024 * 1024) throw new Error('EPUB package unavailable');
    return (await entry.buffer()).toString('utf8');
  };
  const container = parser.parse(await read('META-INF/container.xml')) as { container?: { rootfiles?: { rootfile?: unknown } } };
  const rootfile = container.container?.rootfiles?.rootfile;
  const opfPath = (Array.isArray(rootfile) ? rootfile[0] : rootfile) as Record<string, unknown> | undefined;
  if (typeof opfPath?.['@_full-path'] !== 'string') throw new Error('EPUB has no package');
  const metadata = (parser.parse(await read(opfPath['@_full-path'])) as { package?: { metadata?: Record<string, unknown> } }).package?.metadata;
  return { titles: texts(metadata?.title), authors: texts(metadata?.creator), subjects: texts(metadata?.subject) };
}
