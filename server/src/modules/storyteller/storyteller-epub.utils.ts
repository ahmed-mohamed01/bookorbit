import * as unzipper from 'unzipper';

export type SourceEpubProblem = 'unreadable_archive' | 'missing_container';

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Whether an EPUB is readable enough for Storyteller to align, checked before a build is claimed.
 *
 * `META-INF/container.xml` is the only way any reader is allowed to locate the OPF, so a file
 * without it cannot be parsed by Storyteller under any import mode - reference, copy or upload
 * alike. Catching that here turns an opaque provider 500 hours into a build into an answer the
 * caller can act on, and stops a retry that could never succeed.
 *
 * Only the zip's central directory is read, so this costs one seek rather than a decompression, and
 * the lookup is case-insensitive to match the reader's own tolerance.
 */
export async function findSourceEpubProblem(absolutePath: string): Promise<SourceEpubProblem | null> {
  let files: unzipper.File[];
  try {
    files = (await unzipper.Open.file(absolutePath)).files;
  } catch {
    return 'unreadable_archive';
  }
  const hasContainer = files.some((file) => normalizeZipPath(file.path).toLowerCase() === 'meta-inf/container.xml');
  return hasContainer ? null : 'missing_container';
}
