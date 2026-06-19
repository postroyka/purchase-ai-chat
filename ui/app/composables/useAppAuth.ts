import type { B24Frame } from '@bitrix24/b24jssdk'
import { readonly } from 'vue'

// App-session bootstrap. Establishes the backend session AFTER useB24().init() has run in
// app.vue, two ways:
//   - Inside the Bitrix24 frame: prove the portal to the backend with one /session/b24 call,
//     passing the frame's AUTH_ID + portal domain. The backend re-checks via app.info.
//   - Standalone (opened directly in a browser, outside B24): ask GET /session whether a cookie
//     session already exists; if not, flip `needsLogin` so the UI shows the login overlay.
//
// State lives in Nuxt useState (keyed), so app.vue and any page/layout share the same reactive
// `needsLogin` / `authed` — and, unlike module-scope refs, it stays per-request-safe if an SSR page
// is ever added (module-scope singletons would leak state between requests). [review I2]

// Pull the portal domain (bare host) + AUTH_ID from the B24 frame. getAuthData() returns
// { access_token, domain, ... } or false when the auth has expired; `domain` is the full target
// origin (https://portal.bitrix24.by). We send the host to the backend, which re-derives + checks
// it against the frame-ancestors allowlist before calling app.info, so a spoofed value is inert.
function readFrameAuth(frame: B24Frame): { domain: string, authId: string } | null {
  try {
    const data = frame.auth.getAuthData() // false when expired
    const authId = data ? data.access_token : ''
    // Prefer the SDK's target origin; fall back to window.name ("domain|appSid") if unavailable.
    let origin = ''
    try {
      origin = frame.getTargetOrigin() || ''
    } catch {
      origin = ''
    }
    const domain = hostFromOrigin(origin) || (window.name ? (window.name.split('|')[0] || '') : '')
    if (!authId || !domain) return null
    return { domain, authId }
  } catch {
    return null
  }
}

// Strip scheme/path/port from an origin string, leaving the bare host. Returns '' on junk.
function hostFromOrigin(origin: string): string {
  if (!origin) return ''
  try {
    return new URL(origin).hostname
  } catch {
    // Not a full URL — best-effort manual strip (e.g. already a bare host).
    return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0]?.split(':')[0] ?? ''
  }
}

export function useAppAuth() {
  const { apiFetch } = useApi()
  const authed = useState<boolean>('app-auth-authed', () => false)
  const needsLogin = useState<boolean>('app-auth-needs-login', () => false)
  // Guards against double-bootstrap (app.vue mounts once, but be defensive about re-entry).
  const bootstrapped = useState<boolean>('app-auth-bootstrapped', () => false)

  // Called once from app.vue after the B24 SDK init resolves. `isInB24` is useB24().isInit().
  async function bootstrap(isInB24: boolean, frame: B24Frame | undefined) {
    if (bootstrapped.value) return
    bootstrapped.value = true

    if (isInB24 && frame) {
      // In-portal: establish the session from the frame's auth. On any failure we DON'T fall back
      // to the standalone login form (a logged-in B24 user shouldn't be asked for a password);
      // requests will simply 401 and surface their own errors.
      const creds = readFrameAuth(frame)
      if (!creds) return
      try {
        await apiFetch('/session/b24', {
          method: 'POST',
          body: { domain: creds.domain, authId: creds.authId }
        })
        authed.value = true
      } catch {
        // Leave authed=false; do not show the standalone login form inside B24.
      }
      return
    }

    // Standalone: do we already have a cookie session?
    try {
      const res = await apiFetch<{ authenticated: boolean }>('/session', { method: 'GET' })
      if (res?.authenticated) {
        authed.value = true
      } else {
        needsLogin.value = true
      }
    } catch {
      // /session is unauthenticated and should not fail; if it does, prompt for login so the
      // user has a path forward rather than a blank screen.
      needsLogin.value = true
    }
  }

  // Called by LoginGate after a successful POST /login: hide the overlay, mark authed.
  function markLoggedIn() {
    authed.value = true
    needsLogin.value = false
  }

  return {
    authed: readonly(authed),
    needsLogin: readonly(needsLogin),
    bootstrap,
    markLoggedIn
  }
}
