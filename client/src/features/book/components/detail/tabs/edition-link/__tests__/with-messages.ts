import { i18n } from '@/i18n'

type MessageTree = { [key: string]: unknown }

// The current catalog values at the paths `shape` names, so an override can be undone.
function pickMessages(shape: MessageTree, source: MessageTree): MessageTree {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      typeof value === 'object' && value !== null ? pickMessages(value as MessageTree, source[key] as MessageTree) : source[key],
    ]),
  )
}

/**
 * Swaps English copy for the length of one test, to prove a component reads a key rather than
 * assembling or transforming the text itself.
 */
export async function withMessages(override: MessageTree, run: () => Promise<void> | void): Promise<void> {
  const original = pickMessages(override, i18n.global.getLocaleMessage('en') as MessageTree)
  i18n.global.mergeLocaleMessage('en', override as never)
  try {
    await run()
  } finally {
    i18n.global.mergeLocaleMessage('en', original as never)
  }
}
