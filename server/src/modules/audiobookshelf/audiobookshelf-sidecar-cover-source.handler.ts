import { Logger } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { CoverSource, CoverSourceHandler } from '../metadata/cover-source-handler';
import { isDecodableImage } from '../metadata/lib/cover';

const MAX_SIDECAR_COVER_BYTES = 20 * 1024 * 1024;

export class AudiobookshelfSidecarCoverSourceHandler implements CoverSourceHandler {
  readonly kind = 'sidecar';
  private readonly logger = new Logger(AudiobookshelfSidecarCoverSourceHandler.name);

  async resolve(bookId: number, source: CoverSource): Promise<Buffer | null> {
    const event = 'scanner.import_sidecar_cover';
    const startedAt = Date.now();

    try {
      const fileStat = await stat(source.absolutePath);
      if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > MAX_SIDECAR_COVER_BYTES) {
        this.logger.warn(
          `[${event}] [fail] bookId=${bookId} path="${sanitizeLogValue(source.absolutePath)}" sizeBytes=${fileStat.size} durationMs=${Date.now() - startedAt} reason=invalid_size - sidecar cover import failed`,
        );
        return null;
      }

      const bytes = await readFile(source.absolutePath);
      if (!(await isDecodableImage(bytes))) {
        this.logger.warn(
          `[${event}] [fail] bookId=${bookId} path="${sanitizeLogValue(source.absolutePath)}" durationMs=${Date.now() - startedAt} reason=corrupt - sidecar cover import failed`,
        );
        return null;
      }

      return bytes;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[${event}] [fail] bookId=${bookId} path="${sanitizeLogValue(source.absolutePath)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - sidecar cover import failed`,
      );
      return null;
    }
  }
}
