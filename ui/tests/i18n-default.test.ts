import { describe, it, expect } from 'vitest'
import { DEFAULT_LOCALE, contentLocales } from '../i18n/i18n'
import en from '../i18n/locales/en.json'
import ru from '../i18n/locales/ru.json'

// #177: the standalone login form (LoginGate.vue, shown outside Bitrix24) must render in Russian.
// Inside B24 the portal overrides the locale via setLocale(getLang()) (app.vue); standalone has no
// portal, so it falls through to i18n.defaultLocale. Two guarantees make the form Russian there:
//   1) defaultLocale is Russian (the DEFAULT_LOCALE single source of truth, used by nuxt.config), and
//   2) the ru bundle carries every login.* key the form reads (no silent fallback to English).
describe('standalone UI locale (#177)', () => {
  it('default locale is Russian', () => {
    expect(DEFAULT_LOCALE).toBe('ru')
  })

  it('the default locale is an actually shipped content locale', () => {
    expect(contentLocales.some(l => l.code === DEFAULT_LOCALE)).toBe(true)
  })

  it('every login.* key the form reads exists and is non-empty in Russian', () => {
    const enLogin = en.login as Record<string, string>
    const ruLogin = ru.login as Record<string, string> | undefined
    expect(ruLogin, 'ru.json is missing the whole "login" section').toBeTruthy()

    for (const key of Object.keys(enLogin)) {
      const value = ruLogin?.[key]
      expect(typeof value, `ru.login.${key} is missing`).toBe('string')
      expect((value ?? '').trim().length, `ru.login.${key} is empty`).toBeGreaterThan(0)
    }
  })

  it('renders the Russian title (smoke)', () => {
    expect((ru.login as Record<string, string>).title).toBe('Вход')
  })
})
