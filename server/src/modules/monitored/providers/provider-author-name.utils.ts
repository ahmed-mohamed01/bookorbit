import { normalizeText } from '../reconcile/observation-matcher';

export function authorKey(name: string): string {
  return normalizeText(name).replace(/ /g, '');
}

export function nameVariants(name: string): string[] {
  return [...new Set([name, name.replace(/([a-z])([A-Z])/g, '$1 $2')])];
}
