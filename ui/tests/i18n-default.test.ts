import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_LOCALE, contentLocales } from '../i18n/i18n'
import { resolveBootLocale } from '../app/utils/boot-locale'
import en from '../i18n/locales/en.json'
import ru from '../i18n/locales/ru.json'

// #177: the standalone login form (LoginGate.vue, shown outside Bitrix24) must render in Russian.
// Inside B24 the portal overrides the locale (resolveBootLocale → setLocale(getLang())); standalone
// has no portal, so it falls through to i18n.defaultLocale. The fix has three load-bearing parts,
// each guarded below: (1) the default IS Russian, (2) nuxt.config actually wires that default, and
// (3) the in-B24 override still wins — so a German/English portal doesn't wrongly render Russian.

describe('standalone UI locale defaults (#177)', () => {
  it('default locale is Russian', () => {
    expect(DEFAULT_LOCALE).toBe('ru')
  })

  it('the default locale is an actually shipped content locale', () => {
    expect(contentLocales.some(l => l.code === DEFAULT_LOCALE)).toBe(true)
  })

  // Guards the exact line the fix changes: nuxt.config must feed DEFAULT_LOCALE into i18n.defaultLocale.
  // A careless revert to `defaultLocale: 'en'` would pass every other test here but reintroduce #177.
  // Asserted against the config source text because nuxt.config.ts can't be imported without booting
  // Nuxt (it calls the auto-imported defineNuxtConfig).
  it('nuxt.config wires defaultLocale to DEFAULT_LOCALE, not a hard-coded literal', () => {
    // vitest runs from the ui/ package root (its "test" script), so cwd is where nuxt.config.ts lives.
    const src = readFileSync(resolve(process.cwd(), 'nuxt.config.ts'), 'utf8')
    expect(src).toMatch(/defaultLocale:\s*DEFAULT_LOCALE/)
    expect(src).not.toMatch(/defaultLocale:\s*['"][a-z]{2}['"]/)
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

  it('the Russian login title is actually Cyrillic (not an English fallback)', () => {
    // Assert script, not the exact wording, so re-phrasing the label doesn't break the test.
    expect((ru.login as Record<string, string>).title).toMatch(/[А-Яа-яЁё]/)
  })
})

// The in-B24 override is implemented in app.vue's onMounted (untestable in this harness), but its
// rule lives in the pure resolveBootLocale — so we test the contract here directly.
describe('resolveBootLocale — portal override vs standalone default (#177)', () => {
  const supported = contentLocales.map(l => l.code)

  it('standalone (not in B24) → null, i.e. keep the i18n default (Russian)', () => {
    expect(resolveBootLocale(false, null, supported)).toBeNull()
    // A portal language is irrelevant when we are not framed.
    expect(resolveBootLocale(false, 'en', supported)).toBeNull()
  })

  it('in B24 with a language we ship → that language wins over the default', () => {
    expect(resolveBootLocale(true, 'en', supported)).toBe('en')
    expect(resolveBootLocale(true, 'ua', supported)).toBe('ua')
    expect(resolveBootLocale(true, 'ru', supported)).toBe('ru')
  })

  it('in B24 with a language we do NOT ship → null, falls back to the default', () => {
    expect(resolveBootLocale(true, 'xx', supported)).toBeNull()
    expect(resolveBootLocale(true, '', supported)).toBeNull()
    expect(resolveBootLocale(true, null, supported)).toBeNull()
  })
})
