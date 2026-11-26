import { ARTIFACT_VERSION, TERMS_VERSION, TEXT_VERSION } from '../../book-knowledge/core/versions';
import { KIND_REVIEW_VERSION } from '../../book-knowledge/core/kind-review';
import { KIND_SPANS_VERSION } from '../../book-knowledge/gliner/kind-spans';
import { DENSE_PROMPT_VERSION } from '../../book-knowledge/xray/dense/dense-prompt';

/** Each part padded to two digits, so a bump to any part changes the value and two changes never cancel out. */
export function bkPromptVersion(parts: readonly number[]): number {
  for (const part of parts) {
    if (!Number.isInteger(part) || part < 0 || part >= 100) throw new RangeError(`BK version part ${part} does not fit two digits`);
  }
  return Number(parts.map((part) => String(part).padStart(2, '0')).join(''));
}

/** Any bump to a BK version it holds raises it, so a change to what BK builds marks existing guides outdated. */
export const BK_PROMPT_VERSION = bkPromptVersion([
  DENSE_PROMPT_VERSION,
  KIND_REVIEW_VERSION,
  KIND_SPANS_VERSION,
  TEXT_VERSION,
  TERMS_VERSION,
  ARTIFACT_VERSION,
]);

/** Bumped by any change to how the BK payload becomes the story guide payload. */
export const BK_PAYLOAD_VERSION = 1;
