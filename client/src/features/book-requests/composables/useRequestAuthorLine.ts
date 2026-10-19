import { useI18n } from 'vue-i18n'
import type { BookRequestItem } from '@bookorbit/types'

export function useRequestAuthorLine() {
  const { t } = useI18n()

  return (request: BookRequestItem | null | undefined): string => {
    if (request?.authors.length) return request.authors.join(', ')
    if (request?.kind === 'batch') {
      return request.batch ? t('bookRequests.detail.batchBooks', { total: request.batch.total }) : t('bookRequests.detail.batch')
    }
    return t('bookRequests.detail.unknownAuthor')
  }
}
