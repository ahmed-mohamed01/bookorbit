import { readFile } from 'fs/promises';

import { hasAbsMetadata, mapAbsMetadata } from './abs-metadata.mapper';
import type { AbsBookMetadata } from './abs-metadata.types';
import type { FormatExtractor, ParsedBookData } from './format-extractor.interface';

function isPlainObject(value: unknown): value is AbsBookMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class JsonSidecarFormatExtractor implements FormatExtractor {
  async extract(absolutePath: string): Promise<ParsedBookData | null> {
    const text = await readFile(absolutePath, 'utf8');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isPlainObject(raw)) return null;

    const data = mapAbsMetadata(raw);
    if (!hasAbsMetadata(data)) return null;

    return data;
  }
}
