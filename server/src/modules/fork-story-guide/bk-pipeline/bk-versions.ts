import { ARTIFACT_VERSION, TERMS_VERSION, TEXT_VERSION } from '../../book-knowledge/core/versions';
import { KIND_REVIEW_VERSION } from '../../book-knowledge/core/kind-review';
import { KIND_SPANS_VERSION } from '../../book-knowledge/gliner/kind-spans';
import { DENSE_PROMPT_VERSION } from '../../book-knowledge/xray/dense/dense-prompt';
import { EVERYDAY_OBJECT_REVIEW_VERSION, NONFICTION_ROLE_REVIEW_VERSION } from '../../book-knowledge/xray/xray-role-review';
import { XRAY_MODE_VERSION } from '../../book-knowledge/xray/xray-mode';

/**
 * A 31-bit FNV-1a hash of the parts in order: any change to any part changes the value, and unlike a
 * padded concatenation it stays a safe integer however many parts there are or how large they grow.
 */
export function bkPromptVersion(parts: readonly number[]): number {
  for (const part of parts) {
    if (!Number.isSafeInteger(part) || part < 0) throw new RangeError(`BK version part ${part} is not a whole number`);
  }
  let hash = 0x811c9dc5;
  for (const char of parts.join('.')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1 || 1;
}

/** Any bump to a BK version it holds changes it, so a change to what BK builds marks existing guides outdated. */
export const BK_PROMPT_VERSION = bkPromptVersion([
  DENSE_PROMPT_VERSION,
  KIND_REVIEW_VERSION,
  KIND_SPANS_VERSION,
  TEXT_VERSION,
  TERMS_VERSION,
  ARTIFACT_VERSION,
  XRAY_MODE_VERSION,
  EVERYDAY_OBJECT_REVIEW_VERSION,
  NONFICTION_ROLE_REVIEW_VERSION,
]);

/** Bumped by any change to how the BK payload becomes the story guide payload. */
export const BK_PAYLOAD_VERSION = 1;
