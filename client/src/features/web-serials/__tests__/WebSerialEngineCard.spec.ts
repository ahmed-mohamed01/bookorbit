import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WebSerialEngineHealth, WebSerialKind } from '@bookorbit/types'
import { i18n } from '@/i18n'
import WebSerialEngineCard from '../components/settings/WebSerialEngineCard.vue'

function health(overrides: Partial<WebSerialEngineHealth> = {}): WebSerialEngineHealth {
  return { ok: true, checkedAt: new Date().toISOString(), version: null, searchableSources: 3, error: null, ...overrides }
}

function mountCard(kind: WebSerialKind, value: WebSerialEngineHealth) {
  return mount(WebSerialEngineCard, {
    props: { kind, url: 'http://novel-sources:8282', health: value, testing: false, testError: null, novelEngine: 'lnreader' },
    global: { plugins: [i18n], stubs: { ConnectionHealth: true } },
  })
}

describe('WebSerialEngineCard', () => {
  it('shows FlareSolverr detected when the last light novel check found a solver', () => {
    expect(
      mountCard('novel', health({ solver: true }))
        .get('[data-testid="engine-solver"]')
        .text(),
    ).toBe('FlareSolverr detected')
  })

  it('shows no solver badge without one, after a failed check, or for manga', () => {
    expect(
      mountCard('novel', health({ solver: false }))
        .find('[data-testid="engine-solver"]')
        .exists(),
    ).toBe(false)
    expect(
      mountCard('novel', health({ ok: false, solver: true }))
        .find('[data-testid="engine-solver"]')
        .exists(),
    ).toBe(false)
    expect(
      mountCard('manga', health({ solver: true }))
        .find('[data-testid="engine-solver"]')
        .exists(),
    ).toBe(false)
  })
})

describe('engine URL placeholders', () => {
  it('suggests the port each light novel engine listens on', () => {
    expect(i18n.global.t('webSerials.settings.sheet.novel.urlPlaceholder.lncrawl')).toBe('http://lncrawl:8181')
    expect(i18n.global.t('webSerials.settings.sheet.novel.urlPlaceholder.lnreader')).toBe('http://novel-sources:8282')
  })
})
