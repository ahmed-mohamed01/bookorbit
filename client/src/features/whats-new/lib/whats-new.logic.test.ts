import { describe, expect, it } from 'vitest'

import { isAllowedImageHost, isIconNameShape, isNewer, isSemverTag, shouldShowPopup } from './whats-new.logic'

describe('isSemverTag', () => {
  it('accepts release tags and rejects dev builds', () => {
    expect(isSemverTag('v1.2.0')).toBe(true)
    expect(isSemverTag('v1.2.0-rc.1')).toBe(true)
    expect(isSemverTag('Local build')).toBe(false)
    expect(isSemverTag(null)).toBe(false)
    expect(isSemverTag('')).toBe(false)
  })
})

describe('isNewer', () => {
  it('compares semver precedence', () => {
    expect(isNewer('v1.2.0', 'v1.1.0')).toBe(true)
    expect(isNewer('v2.0.0', 'v1.9.9')).toBe(true)
    expect(isNewer('v1.1.0', 'v1.1.0')).toBe(false)
    expect(isNewer('v1.0.0', 'v1.1.0')).toBe(false)
    expect(isNewer('Local build', 'v1.0.0')).toBe(false)
  })
})

describe('isAllowedImageHost', () => {
  it('allows GitHub attachment hosts only', () => {
    expect(isAllowedImageHost('https://github.com/user-attachments/assets/x')).toBe(true)
    expect(isAllowedImageHost('https://user-images.githubusercontent.com/1/x.png')).toBe(true)
    expect(isAllowedImageHost('https://evil.example.com/x.png')).toBe(false)
    expect(isAllowedImageHost('http://github.com/user-attachments/assets/x')).toBe(false)
    expect(isAllowedImageHost('https://github.com/o/r/raw/main/x.png')).toBe(false)
    expect(isAllowedImageHost('nonsense')).toBe(false)
  })
})

describe('isIconNameShape', () => {
  it('accepts PascalCase icon names and rejects utility exports', () => {
    expect(isIconNameShape('BookHeart')).toBe(true)
    expect(isIconNameShape('Zap')).toBe(true)
    expect(isIconNameShape('createLucideIcon')).toBe(false)
    expect(isIconNameShape('icons')).toBe(false)
    expect(isIconNameShape('book-heart')).toBe(false)
    expect(isIconNameShape(null)).toBe(false)
  })
})

describe('shouldShowPopup', () => {
  const base = { hasUnseen: true, popupEnabled: true, dismissedThisSession: false, routeName: 'dashboard', alreadyOpen: false }

  it('shows when there is unseen content and conditions allow', () => {
    expect(shouldShowPopup(base)).toBe(true)
  })

  it('suppresses while in the reader', () => {
    expect(shouldShowPopup({ ...base, routeName: 'reader' })).toBe(false)
  })

  it('suppresses when disabled, dismissed, already open, or nothing unseen', () => {
    expect(shouldShowPopup({ ...base, popupEnabled: false })).toBe(false)
    expect(shouldShowPopup({ ...base, dismissedThisSession: true })).toBe(false)
    expect(shouldShowPopup({ ...base, alreadyOpen: true })).toBe(false)
    expect(shouldShowPopup({ ...base, hasUnseen: false })).toBe(false)
  })
})
