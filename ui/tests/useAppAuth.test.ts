import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { useApi } from '../app/composables/useApi'

// useAppAuth holds state in Nuxt useState. With no Nuxt env we stub useState with a fresh ref per
// key; re-importing via freshUseAppAuth() each test gives a clean slate (one useAppAuth() call per
// test, so the per-call refs are the shared state under test). $fetch and useApi are stubbed as
// globals, mirroring useMetrics.test.ts.
const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('readonly', readonly)
  vi.stubGlobal('useState', (_key: string, init?: () => unknown) => ref(init ? init() : undefined))
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('useApi', useApi) // real wrapper over the $fetch mock
})

async function freshUseAppAuth() {
  const mod = await import('../app/composables/useAppAuth')
  return mod.useAppAuth()
}

// Minimal B24Frame double exposing only what readFrameAuth touches.
function frameStub(over: { authData?: unknown, targetOrigin?: string } = {}) {
  return {
    auth: {
      getAuthData: () => (over.authData ?? { access_token: 'AUTH_TOKEN_123', domain: 'https://acme.bitrix24.by' })
    },
    getTargetOrigin: () => (over.targetOrigin ?? 'https://acme.bitrix24.by')
  } as never
}

describe('useAppAuth — standalone (outside Bitrix24)', () => {
  it('GET /session=false → needsLogin true, authed false', async () => {
    fetchMock.mockResolvedValue({ authenticated: false })
    const { bootstrap, needsLogin, authed } = await freshUseAppAuth()

    await bootstrap(false, undefined)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/session')
    expect(opts?.headers?.['X-PAI-Auth']).toBe('1') // via useApi
    expect(needsLogin.value).toBe(true)
    expect(authed.value).toBe(false)
  })

  it('GET /session=true → authed true, no login prompt', async () => {
    fetchMock.mockResolvedValue({ authenticated: true })
    const { bootstrap, needsLogin, authed } = await freshUseAppAuth()

    await bootstrap(false, undefined)

    expect(authed.value).toBe(true)
    expect(needsLogin.value).toBe(false)
  })

  it('GET /session failure → needsLogin true (gives the user a path forward)', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    const { bootstrap, needsLogin } = await freshUseAppAuth()

    await bootstrap(false, undefined)

    expect(needsLogin.value).toBe(true)
  })

  it('markLoggedIn flips authed on and needsLogin off', async () => {
    fetchMock.mockResolvedValue({ authenticated: false })
    const { bootstrap, markLoggedIn, needsLogin, authed } = await freshUseAppAuth()
    await bootstrap(false, undefined)
    expect(needsLogin.value).toBe(true)

    markLoggedIn()
    expect(authed.value).toBe(true)
    expect(needsLogin.value).toBe(false)
  })
})

describe('useAppAuth — framed (inside Bitrix24)', () => {
  it('POSTs /session/b24 with {domain, authId} from the frame and marks authed', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { bootstrap, authed, needsLogin } = await freshUseAppAuth()

    await bootstrap(true, frameStub())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/session/b24')
    expect(opts?.method).toBe('POST')
    expect(opts?.body).toEqual({ domain: 'acme.bitrix24.by', authId: 'AUTH_TOKEN_123' })
    expect(opts?.credentials).toBe('include')
    expect(authed.value).toBe(true)
    expect(needsLogin.value).toBe(false) // never prompt for a password inside B24
  })

  it('does NOT fall back to the login form when /session/b24 fails inside B24', async () => {
    fetchMock.mockRejectedValue({ status: 401 })
    const { bootstrap, authed, needsLogin } = await freshUseAppAuth()

    await bootstrap(true, frameStub())

    expect(authed.value).toBe(false)
    expect(needsLogin.value).toBe(false) // critical: a logged-in B24 user is not shown a password box
  })

  it('does not call the backend when the frame auth is expired (getAuthData=false)', async () => {
    const { bootstrap, authed, needsLogin } = await freshUseAppAuth()

    await bootstrap(true, frameStub({ authData: false }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(authed.value).toBe(false)
    expect(needsLogin.value).toBe(false)
  })

  it('is idempotent — a second bootstrap() is a no-op', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { bootstrap } = await freshUseAppAuth()

    await bootstrap(true, frameStub())
    await bootstrap(true, frameStub())

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
