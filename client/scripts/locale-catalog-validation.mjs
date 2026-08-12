import { validateLocaleMessage, validateSlotCountMessage } from './locale-message-validation.mjs'

export function flattenCatalog(value, prefix = '', output = new Map()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${prefix || 'catalog root'} must be a message object`)
  }

  for (const [key, child] of Object.entries(value)) {
    const messageKey = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') output.set(messageKey, child)
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenCatalog(child, messageKey, output)
    else throw new Error(`${messageKey} must be a string or message object`)
  }

  return output
}

function messageErrors({ key, locale, message, referenceMessage, slotCountKeys }) {
  if (referenceMessage === undefined) return [`${locale}: unexpected key ${key}`]

  const errors = []
  if (message.length === 0) errors.push(`${locale}: empty message ${key}`)
  if (message.includes('\u2014')) errors.push(`${locale}: Unicode em dash is not allowed in ${key}`)
  if (/<[^>]+>/.test(message)) errors.push(`${locale}: HTML is not allowed in ${key}`)
  errors.push(...validateLocaleMessage({ key, locale, message, referenceMessage }))
  if (slotCountKeys.has(key)) errors.push(...validateSlotCountMessage({ key, locale, message }))
  return errors
}

export function validateCatalogs({ catalogs, referencedKeys = new Set(), slotCountKeys = new Set() }) {
  const reference = catalogs.get('en')
  if (!reference) throw new Error('English reference catalog is required')

  const errors = []
  for (const key of referencedKeys) {
    if (!reference.has(key)) errors.push(`en: missing key referenced in source ${key}`)
  }

  for (const [locale, catalog] of catalogs) {
    for (const [key, message] of catalog) {
      errors.push(...messageErrors({ key, locale, message, referenceMessage: reference.get(key), slotCountKeys }))
    }
  }

  return errors
}

export function findInvalidTargetMessages({ catalogs, slotCountKeys = new Set() }) {
  const reference = catalogs.get('en')
  if (!reference) throw new Error('English reference catalog is required')

  const invalid = []
  for (const [locale, catalog] of catalogs) {
    if (locale === 'en') continue
    for (const [key, message] of catalog) {
      const errors = messageErrors({ key, locale, message, referenceMessage: reference.get(key), slotCountKeys })
      if (errors.length > 0) invalid.push({ locale, key, errors })
    }
  }

  return invalid
}
