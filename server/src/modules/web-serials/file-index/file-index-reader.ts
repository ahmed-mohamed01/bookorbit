import { BadGatewayException, GatewayTimeoutException } from '@nestjs/common';

import { WebSerialErrorCode, type WebSerialFileIndexFormat, type WebSerialFileIndexKeyMap } from '@bookorbit/types';
import { readBoundedText, ResponseTooLargeError } from '../../../common/utils/bounded-response';
import { codedError } from '../web-serials-error.utils';
import { assertFileIndexOk, fetchFileIndex } from './file-index-http';
import {
  LISTING_MAX_FILES,
  parseHtmlListingPage,
  parseJsonListing,
  relativeListingPath,
  type ListingFile,
  type ParsedListing,
} from './file-index-listing';

export const LISTING_MAX_BYTES = 64 * 1024 * 1024;
const HTML_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const HTML_MAX_PAGES = 5_000;
export const HTML_PAGE_DELAY_MS = 250;

export interface FileIndexSource {
  listingUrl: string;
  baseUrl: string;
  /** null detects the format from the first response. */
  format: WebSerialFileIndexFormat | null;
  keyMap: WebSerialFileIndexKeyMap;
  authorization: string | null;
}

export interface ListingValidators {
  etag: string | null;
  lastModified: string | null;
}

export type ListingReadResult =
  { notModified: true } | ({ notModified: false; format: WebSerialFileIndexFormat; listing: ParsedListing; pages: number } & ListingValidators);

export interface ListingReadOptions {
  signal: AbortSignal;
  /** Sent as conditional headers; a JSON listing that did not change then costs one empty response. */
  validators?: ListingValidators | null;
  pageDelayMs?: number;
  maxPages?: number;
}

export async function readListing(source: FileIndexSource, options: ListingReadOptions): Promise<ListingReadResult> {
  const conditional = source.format === 'json' ? conditionalHeaders(options.validators) : {};
  const response = await fetchFileIndex(source.listingUrl, {
    headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...conditional },
    authorization: source.authorization,
    signal: options.signal,
  });
  assertFileIndexOk(response);
  if (response.status === 304) return { notModified: true };

  const text = await readText(response, LISTING_MAX_BYTES);
  const format = source.format ?? detectFormat(response, text);
  const validators = { etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };

  if (format === 'json') {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BadGatewayException(codedError('The file index is not valid JSON', WebSerialErrorCode.FileIndexUnreadable));
    }
    return { notModified: false, format, listing: parseJsonListing(body, source.keyMap), pages: 1, ...validators };
  }

  const crawled = await crawlHtml(source, text, options);
  return { notModified: false, format, ...crawled, etag: null, lastModified: null };
}

/** Breadth first over directory pages below the listing URL, one page at a time with a polite delay. */
async function crawlHtml(
  source: FileIndexSource,
  firstPage: string,
  options: ListingReadOptions,
): Promise<{ listing: ParsedListing; pages: number }> {
  const files: ListingFile[] = [];
  const seen = new Set<string>([source.listingUrl]);
  const queue: string[] = [];
  let pages = 0;
  let truncated = false;
  let html: string | null = firstPage;
  let pageUrl = source.listingUrl;

  for (;;) {
    pages += 1;
    const page = parseHtmlListingPage(html, pageUrl);
    for (const file of page.files) {
      if (files.length >= LISTING_MAX_FILES) {
        truncated = true;
        break;
      }
      const path = relativeListingPath(file.url, source.baseUrl);
      if (path) files.push({ path, name: file.name, size: null });
    }
    for (const folder of page.folders) {
      if (!seen.has(folder)) {
        seen.add(folder);
        queue.push(folder);
      }
    }
    if (truncated || queue.length === 0) break;
    if (pages >= (options.maxPages ?? HTML_MAX_PAGES)) {
      truncated = true;
      break;
    }

    pageUrl = queue.shift()!;
    await delay(options.pageDelayMs ?? HTML_PAGE_DELAY_MS, options.signal);
    const response = await fetchFileIndex(pageUrl, { headers: { Accept: 'text/html' }, authorization: source.authorization, signal: options.signal });
    assertFileIndexOk(response);
    html = await readText(response, HTML_PAGE_MAX_BYTES);
  }

  return { listing: { files, truncated }, pages };
}

function detectFormat(response: Response, text: string): WebSerialFileIndexFormat {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  return /^\s*[[{]/.test(text) ? 'json' : 'html';
}

function conditionalHeaders(validators: ListingValidators | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers['If-None-Match'] = validators.etag;
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

async function readText(response: Response, limitBytes: number): Promise<string> {
  try {
    return await readBoundedText(response, limitBytes);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new BadGatewayException(codedError('The file index is larger than BookOrbit reads', WebSerialErrorCode.FileIndexUnreadable));
    }
    throw error;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted)
    return Promise.reject(new GatewayTimeoutException(codedError('The file index refresh was stopped', WebSerialErrorCode.EngineTimeout)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GatewayTimeoutException(codedError('The file index refresh was stopped', WebSerialErrorCode.EngineTimeout)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
