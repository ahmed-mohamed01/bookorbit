import type { WebSerialFileIndexKeyMap } from '@bookorbit/types';

export const LISTING_MAX_FILES = 250_000;
export const LISTING_MAX_DEPTH = 32;
const PATH_MAX_LENGTH = 2048;
const NAME_MAX_LENGTH = 1000;

/** One file of a listing; `path` is relative to the index's base URL, with `/` between folders and no leading slash. */
export interface ListingFile {
  path: string;
  name: string;
  size: number | null;
}

export interface ParsedListing {
  files: ListingFile[];
  truncated: boolean;
}

const DEFAULT_KEYS: Required<WebSerialFileIndexKeyMap> = { name: 'name', path: 'path', folders: 'folders', files: 'files', size: 'size' };

interface Frame {
  node: Record<string, unknown>;
  parentPath: string;
  depth: number;
  /** The listing's own root object: its name is the site's, not a folder under the base URL. */
  root: boolean;
}

/**
 * Walks a JSON folder tree (`{name, path, folders[], files[]}` by default) without recursion, so a deep or hostile tree
 * cannot overflow the stack. A node without a path gets its parent's path plus its name. A root array lists top-level
 * folders; a root object is the base folder itself.
 */
export function parseJsonListing(body: unknown, keyMap: WebSerialFileIndexKeyMap = {}): ParsedListing {
  const keys = { ...DEFAULT_KEYS, ...stripEmpty(keyMap) };
  const files: ListingFile[] = [];
  const root = !Array.isArray(body);
  const stack: Frame[] = (root ? [body] : body).filter(isRecord).map((node) => ({ node, parentPath: '', depth: 0, root }));
  let truncated = false;

  while (stack.length > 0) {
    const { node, parentPath, depth, root: isRoot } = stack.pop()!;
    const folderPath = nodePath(node, keys, parentPath, isRoot);
    if (folderPath === null) continue;

    for (const file of arrayOf(node[keys.files])) {
      if (files.length >= LISTING_MAX_FILES) {
        truncated = true;
        break;
      }
      const path = nodePath(file, keys, folderPath, false);
      if (!path) continue;
      const name = typeof file[keys.name] === 'string' ? (file[keys.name] as string) : lastSegment(path);
      if (!name || name.length > NAME_MAX_LENGTH) continue;
      files.push({ path, name, size: sizeOf(file[keys.size]) });
    }
    if (files.length >= LISTING_MAX_FILES) {
      truncated ||= stack.length > 0 || arrayOf(node[keys.folders]).length > 0;
      break;
    }

    const children = arrayOf(node[keys.folders]);
    if (children.length > 0 && depth + 1 > LISTING_MAX_DEPTH) {
      truncated = true;
      continue;
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i]!, parentPath: folderPath, depth: depth + 1, root: false });
  }

  return { files, truncated };
}

export interface HtmlListingPage {
  /** Absolute URLs of sub-folders below the page. */
  folders: string[];
  files: Array<{ url: string; name: string }>;
}

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/**
 * Links of one directory page (nginx, Apache, h5ai and similar). Only links below the page itself count, so parent
 * folders, sort links and links to other sites are ignored.
 */
export function parseHtmlListingPage(html: string, pageUrl: string): HtmlListingPage {
  const page = new URL(pageUrl);
  const base = page.href.endsWith('/') ? page.href : `${page.href}/`;
  const folders = new Set<string>();
  const files = new Map<string, string>();

  for (const match of html.matchAll(ANCHOR)) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('?') || /^(?:javascript|mailto|data):/i.test(href)) continue;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.search || target.origin !== page.origin) continue;
    target.hash = '';
    if (!target.href.startsWith(base) || target.href === base) continue;
    if (target.pathname.endsWith('/')) folders.add(target.href);
    else files.set(target.href, safeDecode(lastSegment(target.pathname)));
  }

  return { folders: [...folders], files: [...files].map(([url, name]) => ({ url, name })) };
}

/** The listing path of an absolute file URL under the base URL, or null when it is outside it. */
export function relativeListingPath(fileUrl: string, baseUrl: string): string | null {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  if (!fileUrl.startsWith(base)) return null;
  const path = fileUrl
    .slice(base.length)
    .split('/')
    .map((segment) => safeDecode(segment))
    .join('/');
  return path && path.length <= PATH_MAX_LENGTH ? path : null;
}

/** The download URL of a listing path: each folder name encoded on its own, so `#`, `?` and `%` in names survive. */
export function listingFileUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${path.split('/').map(encodeURIComponent).join('/')}`;
}

function nodePath(node: Record<string, unknown>, keys: Required<WebSerialFileIndexKeyMap>, parentPath: string, root: boolean): string | null {
  const raw = node[keys.path];
  let path: string;
  if (typeof raw === 'string') {
    path = raw;
  } else if (root) {
    path = '';
  } else {
    const name = node[keys.name];
    if (typeof name !== 'string' || !name) return null;
    path = parentPath ? `${parentPath}/${name}` : name;
  }
  path = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (path.length > PATH_MAX_LENGTH || path.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return path;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sizeOf(value: unknown): number | null {
  const size = typeof value === 'string' ? Number(value) : value;
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function stripEmpty(keyMap: WebSerialFileIndexKeyMap): WebSerialFileIndexKeyMap {
  return Object.fromEntries(Object.entries(keyMap).filter(([, value]) => typeof value === 'string' && value.trim())) as WebSerialFileIndexKeyMap;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
