import { describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { Permission } from '@bookorbit/types'
import { routes } from '@/router'

function find(records: readonly RouteRecordRaw[], name: string): RouteRecordRaw | undefined {
  for (const record of records) {
    if (record.name === name) return record
    const child = record.children ? find(record.children, name) : undefined
    if (child) return child
  }
  return undefined
}

describe('web serials queue route', () => {
  it('redirects the notification link to the single page on its queue tab', () => {
    expect(find(routes, 'web-serials-queue')?.redirect).toEqual({ name: 'web-serials', query: { tab: 'queue' } })
  })
})

describe('web serials route permissions', () => {
  it('sends someone without access away from the page, which the old queue link redirects to', () => {
    expect(find(routes, 'web-serials')?.meta?.requiredPermission).toBe(Permission.WebSerialAccess)
  })

  it('keeps the setup page to app settings managers', () => {
    const settings = find(routes, 'settings-admin-web-serials')
    expect(settings?.meta?.requiredPermission).toBe(Permission.ManageAppSettings)
    expect(settings?.meta?.permissionFallback).toBe('settings-account-profile')
  })
})
