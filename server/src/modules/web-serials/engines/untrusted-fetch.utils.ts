import { BadGatewayException } from '@nestjs/common';

import { safeFetch } from '../../../common/utils/safe-fetch';

const MAX_REDIRECTS = 5;

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
]);
const IMAGE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
]);
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * GET for a URL a scraped page or plugin chose (chapter images, novel covers). Every hop is checked by
 * `safeFetch` and pinned to the address that passed, so a public URL cannot redirect or rebind to an internal host.
 */
export async function fetchUntrusted(rawUrl: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await safeFetch(current, { ...init, redirect: 'manual' }, { signal: init.signal, pinResolvedAddress: true });
    if (response.status < 300 || response.status >= 400) return response;
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location) throw new BadGatewayException('The remote server redirected without a location');
    current = new URL(location, current).href;
  }
  throw new BadGatewayException('The remote server redirected too many times');
}

export function imageExtension(mediaType: string): string | undefined {
  return IMAGE_EXTENSIONS.get(mediaType);
}

/** The declared type when it is a known image type, else the type the bytes show; null when neither is a supported image. */
export function resolveImageType(declared: string, body: Buffer): string | null {
  const normalized = IMAGE_ALIASES.get(declared) ?? declared;
  if (IMAGE_EXTENSIONS.has(normalized)) return normalized;
  return sniffImageType(body);
}

/** Whether a declared content type can still turn out to be an image once the bytes are read. */
export function mayBeImageType(declared: string): boolean {
  return IMAGE_EXTENSIONS.has(IMAGE_ALIASES.get(declared) ?? declared) || GENERIC_TYPES.has(declared);
}

export function declaredContentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('latin1')))
    return 'image/avif';
  return null;
}
