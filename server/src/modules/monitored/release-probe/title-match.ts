import { foldDiacritics } from '../monitored-text.utils';

export function normalizeTitleTokens(text: string): string[] {
  return foldDiacritics(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

const LEADING_ARTICLES = new Set(['a', 'an', 'the']);

function withoutLeadingArticle(tokens: string[]): string[] {
  return tokens.length > 1 && LEADING_ARTICLES.has(tokens[0]) ? tokens.slice(1) : tokens;
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

export function titleTokensMatch(workTitle: string, candidateTitle: string): boolean {
  const workTokens = withoutLeadingArticle(normalizeTitleTokens(workTitle));
  if (workTokens.length === 0) return false;
  const candidates = [candidateTitle, ...candidateTitle.split(/:| - | – |[()[\]|]/u)];
  return candidates.some((candidate) => sameTokens(workTokens, withoutLeadingArticle(normalizeTitleTokens(candidate))));
}

export function authorMatches(workAuthor: string, candidateAuthorText: string): boolean {
  const workTokens = normalizeTitleTokens(workAuthor).filter((token) => token.length > 1);
  if (workTokens.length === 0) return false;
  const candidateTokens = new Set(normalizeTitleTokens(candidateAuthorText).filter((token) => token.length > 1));
  return workTokens.every((token) => candidateTokens.has(token));
}
