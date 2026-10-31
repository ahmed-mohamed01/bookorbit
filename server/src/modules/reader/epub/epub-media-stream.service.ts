import { createReadStream } from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import type * as unzipper from 'unzipper';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { storedZipEntryDataOffset, type ByteRange } from './epub-zip-range';

const MAX_ENTRIES = 512;

// Size as well as mtime: a cached entry is served without reading the zip
// directory again, so a replaced archive must not look like the old one.
export interface ArchiveVersion {
  path: string;
  mtime: number;
  size: number;
}

export interface StoredEntry {
  archivePath: string;
  dataStart: number;
  layout: { size: number };
  etag: string;
}

type LoadedEntry = StoredEntry;

interface CachedEntry {
  entry: Promise<LoadedEntry | null>;
  loaded?: LoadedEntry | null;
}

// Serves uncompressed EPUB entries (read-along audio) as byte ranges straight
// from the archive.
@Injectable()
export class EpubMediaStreamService {
  private readonly logger = new Logger(EpubMediaStreamService.name);
  private readonly entries = new Map<string, CachedEntry>();

  // Lets a repeat request skip opening the archive's zip directory.
  knownEntry(archive: ArchiveVersion, entryPath: string): StoredEntry | null {
    const slot = this.touch(this.keyOf(archive, entryPath));
    return slot?.loaded ?? null;
  }

  // Null when the entry is compressed or encrypted and can only be sent whole.
  storedEntry(bookId: number, archive: ArchiveVersion, entryPath: string, entry: unzipper.File): Promise<StoredEntry | null> {
    const key = this.keyOf(archive, entryPath);
    const cached = this.touch(key);
    if (cached) return cached.entry;

    const slot: CachedEntry = { entry: this.loadStoredEntry(bookId, archive, entry) };
    this.entries.set(key, slot);
    slot.entry.then(
      (stored) => {
        if (this.entries.get(key) !== slot) return;
        slot.loaded = stored;
        this.evict();
      },
      () => this.entries.delete(key),
    );
    this.evict();
    return slot.entry;
  }

  openRange(stored: StoredEntry, range: ByteRange): NodeJS.ReadableStream {
    return createReadStream(stored.archivePath, { start: stored.dataStart + range.start, end: stored.dataStart + range.end });
  }

  private keyOf(archive: ArchiveVersion, entryPath: string): string {
    return [archive.path, archive.mtime, archive.size, entryPath].join('|');
  }

  private touch(key: string): CachedEntry | undefined {
    const slot = this.entries.get(key);
    if (slot) {
      this.entries.delete(key);
      this.entries.set(key, slot);
    }
    return slot;
  }

  private async loadStoredEntry(bookId: number, archive: ArchiveVersion, entry: unzipper.File): Promise<LoadedEntry | null> {
    const startedAtMs = Date.now();
    let dataStart: number | null;
    try {
      dataStart = await storedZipEntryDataOffset(archive.path, entry);
    } catch (err) {
      this.logFailure('epub.stream_range', bookId, entry, startedAtMs, err, 'range read failed, sending the full entry');
      return null;
    }
    if (dataStart === null) return null;

    const version = `${Math.trunc(archive.mtime)}-${entry.crc32}-${entry.offsetToLocalFileHeader}`;
    return { archivePath: archive.path, dataStart, layout: { size: entry.uncompressedSize }, etag: `"${version}"` };
  }

  private evict() {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) return;
      this.entries.delete(key);
    }
  }

  private logFailure(event: string, bookId: number, entry: unzipper.File, startedAtMs: number, err: unknown, message: string) {
    const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
    this.logger.warn(
      `[${event}] [fail] bookId=${bookId} path="${sanitizeLogValue(entry.path)}" durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - ${message}`,
    );
  }
}
