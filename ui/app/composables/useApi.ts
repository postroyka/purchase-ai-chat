// Thin wrapper around $fetch for the backend API. Every call carries:
//   - header `X-PAI-Auth: '1'` — the CSRF token the backend requires alongside the session
//     cookie (the cookie is SameSite=None so it rides cross-site requests; the custom header,
//     which a cross-site page cannot set without a CORS preflight we never grant, proves the
//     request came from our own app).
//   - `credentials: 'include'` — send/accept the pai_sess cookie even cross-origin (the app runs
//     inside the cross-site Bitrix24 iframe, where credentials would otherwise be omitted).
//
// In dev the nitro devProxy still injects the Bearer token server-side for /upload, /job and
// /metrics/data, so these extra fields are harmless there; in prod they are what authenticates
// the browser (no token is ever shipped to the bundle — #41/#105 P1).

import type { NitroFetchRequest, NitroFetchOptions } from 'nitropack'

export function useApi() {
  function apiFetch<T = unknown>(
    request: NitroFetchRequest,
    options: NitroFetchOptions<NitroFetchRequest> = {}
  ): Promise<T> {
    // Merge into a plain object. options.headers may also be Headers | string[][]; every call site
    // passes a Record (or nothing), so narrow at runtime and ignore the other shapes rather than an
    // unchecked `as` cast.
    const provided = options.headers
    const base: Record<string, string> = (provided && typeof provided === 'object'
      && !Array.isArray(provided) && !(typeof Headers !== 'undefined' && provided instanceof Headers))
      ? provided as Record<string, string>
      : {}
    return $fetch<T>(request, {
      ...options,
      credentials: 'include',
      headers: { ...base, 'X-PAI-Auth': '1' }
    })
  }

  return { apiFetch }
}
