import { computed, type Ref } from 'vue'
export type ExternalProvider = 'hardcover' | 'manga' | 'lightNovels'
export function useExternalSearchText(
  providers: Ref<ExternalProvider[]>,
  query: Ref<string>,
  requestsVisible: Ref<boolean>,
  t: (key: string, params?: Record<string, string>) => string,
  locale?: Ref<string>,
) {
  return computed(() => {
    const names = new Intl.ListFormat(locale?.value || 'en', { type: 'conjunction' }).format(
      providers.value.map((provider) => t(`commandPalette.external.providers.${provider}`)),
    )
    return {
      label: t('commandPalette.external.searchProviders', { providers: names, q: query.value }),
      description: t(requestsVisible.value ? 'commandPalette.external.descriptionProviders' : 'commandPalette.external.descriptionProvidersHidden'),
    }
  })
}
