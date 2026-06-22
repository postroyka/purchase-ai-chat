// Boot-time locale decision for the SPA (#177). Extracted as a pure function so the rule is unit-
// testable — app.vue's onMounted (which reads the B24 frame and calls setLocale) can't be exercised
// in the lightweight happy-dom test harness, but this can.
//
// The rule:
//   - Inside Bitrix24, the portal dictates the language (frame.getLang()). We honor it ONLY when we
//     actually ship that locale; otherwise we leave the current locale untouched (the caller logs the
//     gap) and it stays at the i18n default.
//   - Standalone (outside any portal), there is no portal to ask. We leave the locale at the i18n
//     default, which is Russian (DEFAULT_LOCALE) — that is what makes the /login form Russian for our
//     Russian-speaking users.
//
// Returns the locale CODE to apply via setLocale(), or null to keep whatever is already loaded (i.e.
// the i18n default). It never invents a locale we don't ship.
export function resolveBootLocale(
  isInB24: boolean,
  portalLang: string | null | undefined,
  supportedCodes: readonly string[]
): string | null {
  if (!isInB24) return null // standalone → keep the i18n default (Russian)
  if (portalLang && supportedCodes.includes(portalLang)) return portalLang // portal language we ship
  return null // in-portal but we don't ship that language → keep the default (caller may log)
}
