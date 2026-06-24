import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 functions are stubbed so we can drive the middleware with synthetic
// events. defineEventHandler becomes the identity function — its only job in
// production is to attach a marker; tests don't need it.
vi.mock('h3', () => ({
  defineEventHandler: <T>(fn: T) => fn,
  getRequestURL: (event: FakeEvent) => new URL(event._url, 'http://test.local'),
  getHeader: (event: FakeEvent, name: string) => event._headers?.[name.toLowerCase()],
  getRequestIP: (event: FakeEvent) => event._ip,
  setResponseHeader: (event: FakeEvent, name: string, value: string) => {
    event._responseHeaders ??= {}
    event._responseHeaders[name.toLowerCase()] = value
  },
  createError: (opts: { statusCode: number; statusMessage: string }) => {
    const err = new Error(opts.statusMessage) as Error & {
      statusCode: number
      statusMessage: string
    }
    err.statusCode = opts.statusCode
    err.statusMessage = opts.statusMessage
    return err
  },
}))

// #105 P3: middleware логирует WARN при 429 (наблюдаемость) — мок, чтобы не тянуть реальный логгер.
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({ warning: () => Promise.resolve() }),
}))

interface FakeEvent {
  _url: string
  _headers?: Record<string, string>
  _responseHeaders?: Record<string, string>
  _ip?: string
}

// Realistic server token: ≥32 chars (intended is `openssl rand -hex 32` = 64 chars).
// The middleware rejects shorter configured tokens as "not configured" (#105 P3).
const VALID_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' // 32 chars

const runtimeConfig: { mcpAuthToken: string; bitrix24OauthEnabled: boolean } = {
  mcpAuthToken: '',
  bitrix24OauthEnabled: false,
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

// h3's defineEventHandler wraps the inner function with markers (__is_event__
// etc.), so the default export's static type is EventHandler. Our mocked
// version (above) is the identity function — at runtime it IS our handler —
// hence the deliberate `as unknown` two-step cast.
const mcpAuthModule = await import('../../../server/middleware/mcp-auth')
const middleware = mcpAuthModule.default as unknown as (event: FakeEvent) => void
const resetRateLimit = mcpAuthModule._resetMcpAuthRateLimitForTests

function callMiddleware(url: string, headers: Record<string, string> = {}) {
  return () => middleware({ _url: url, _headers: headers })
}

describe('mcp-auth middleware', () => {
  beforeEach(() => {
    runtimeConfig.mcpAuthToken = VALID_TOKEN
    runtimeConfig.bitrix24OauthEnabled = false
    resetRateLimit() // #105 P3: чистим анти-брутфорс счётчики между тестами
  })

  it('yields when NUXT_BITRIX24_OAUTH_ENABLED=true AND the request carries a Bearer header (toolkit middleware owns auth)', () => {
    // PR-2c-bearer (#217): when OAuth is on, this h3-level middleware
    // skips so the `server/mcp/index.ts` toolkit middleware can do the
    // Bearer-to-tenant resolution (it also wraps next() in an ALS scope,
    // which h3 middleware can't).
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.mcpAuthToken = '' // even with no MCP_AUTH_TOKEN
    expect(callMiddleware('/mcp', { authorization: 'Bearer abc' })()).toBeUndefined()
    expect(callMiddleware('/mcp/messages', { authorization: 'Bearer abc' })()).toBeUndefined()
  })

  it('flag=true defence-in-depth: refuses 401 here if no Bearer header (in case toolkit middleware fails to register)', () => {
    // Security round-4 finding: yielding unconditionally when the flag
    // is on means a missing/broken toolkit middleware leaves /mcp open.
    // This h3 layer requires AT LEAST the `Authorization: Bearer …`
    // shape before yielding — worst case a missing toolkit middleware
    // still produces 401, not an auth bypass.
    runtimeConfig.bitrix24OauthEnabled = true
    expect(callMiddleware('/mcp')).toThrow(/Bearer required/)
    expect(callMiddleware('/mcp', { authorization: 'Basic xyz' })).toThrow(/Bearer required/)
    expect(callMiddleware('/mcp', { authorization: 'Bearer ' })).toThrow(/Bearer required/)
  })

  it('flag=true no-Bearer 401 carries the §11 WWW-Authenticate header (RFC 6750)', () => {
    // Caught by the #224 docker-smoke OAuth-on boot: this h3 branch fires
    // BEFORE the toolkit middleware, so without setting the header itself
    // the production no-Bearer 401 ships bare — breaking the §11 promise
    // that every Bearer-auth 401 is grep-able by errorCode.
    runtimeConfig.bitrix24OauthEnabled = true
    const event: FakeEvent = { _url: '/mcp', _headers: {} }
    expect(() => middleware(event)).toThrow(/Bearer required/)
    expect(event._responseHeaders?.['www-authenticate']).toBe(
      'Bearer error="invalid_token", errorCode="BEARER-UNKNOWN", error_description="Bearer required"',
    )
  })

  it('skips paths outside /mcp', () => {
    expect(callMiddleware('/api/health')()).toBeUndefined()
    expect(callMiddleware('/')()).toBeUndefined()
  })

  it('does not guard sibling paths that merely share the /mcp prefix', () => {
    // /mcphacked must not be auth-gated — it's a different route entirely and
    // should reach the router as 404, not be confused with the MCP endpoint.
    expect(callMiddleware('/mcphacked')()).toBeUndefined()
    expect(callMiddleware('/mcp-debug')()).toBeUndefined()
  })

  it('guards /mcp exactly', () => {
    expect(callMiddleware('/mcp')).toThrow(/Missing Authorization/)
  })

  it('guards /mcp/<sub>', () => {
    expect(callMiddleware('/mcp/messages')).toThrow(/Missing Authorization/)
  })

  it('returns 503 when the server token is not configured', () => {
    runtimeConfig.mcpAuthToken = ''
    expect(callMiddleware('/mcp', { authorization: 'Bearer x' })).toThrow(
      expect.objectContaining({ statusCode: 503 }),
    )
  })

  it('returns 503 when the token is left at the .env.example placeholder', () => {
    runtimeConfig.mcpAuthToken = 'replace-with-secure-token'
    expect(
      callMiddleware('/mcp', { authorization: 'Bearer replace-with-secure-token' }),
    ).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('returns 503 for the placeholder token even with no Authorization header (fires before the header check)', () => {
    runtimeConfig.mcpAuthToken = 'replace-with-secure-token'
    expect(callMiddleware('/mcp')).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('returns 503 when the configured token is shorter than 32 chars (#105 P3)', () => {
    // A too-short token would pass timingSafeEqual and guard /mcp with a
    // guessable/brute-forceable secret — treat it as "not configured".
    runtimeConfig.mcpAuthToken = 'short-token'
    expect(callMiddleware('/mcp', { authorization: 'Bearer short-token' })).toThrow(
      expect.objectContaining({ statusCode: 503 }),
    )
  })

  it('rejects a missing Authorization header with 401', () => {
    expect(callMiddleware('/mcp')).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Missing Authorization header' }),
    )
  })

  it('webhook-mode missing-header 401 carries WWW-Authenticate: Bearer realm (RFC 6750 §3, #196)', () => {
    // No credentials supplied → realm-only challenge, NO error code per the
    // RFC (an error code is for credentials that were sent but rejected).
    const event: FakeEvent = { _url: '/mcp', _headers: {} }
    expect(() => middleware(event)).toThrow(/Missing Authorization/)
    expect(event._responseHeaders?.['www-authenticate']).toBe('Bearer realm="bx24-template-mcp"')
  })

  it('rejects a malformed Authorization header with 401', () => {
    expect(callMiddleware('/mcp', { authorization: VALID_TOKEN })).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }),
    )
  })

  it('webhook-mode invalid-token 401 carries WWW-Authenticate with error="invalid_token" (RFC 6750 §3, #196)', () => {
    // Credentials WERE supplied but rejected → include the error code so a
    // spec-following client stops retrying the same value.
    const event: FakeEvent = { _url: '/mcp', _headers: { authorization: 'Bearer wrong-token' } }
    expect(() => middleware(event)).toThrow(/Invalid bearer token/)
    expect(event._responseHeaders?.['www-authenticate']).toBe(
      'Bearer realm="bx24-template-mcp", error="invalid_token", error_description="Invalid bearer token"',
    )
  })

  it('rejects a wrong bearer token with 401', () => {
    expect(callMiddleware('/mcp', { authorization: 'Bearer wrong-token' })).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }),
    )
  })

  it('rejects a token of wrong length', () => {
    expect(callMiddleware('/mcp', { authorization: `Bearer ${VALID_TOKEN}extra` })).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    )
  })

  it('accepts the correct bearer token', () => {
    expect(callMiddleware('/mcp', { authorization: `Bearer ${VALID_TOKEN}` })()).toBeUndefined()
  })

  it('accepts case-insensitive Bearer scheme', () => {
    expect(callMiddleware('/mcp', { authorization: `bearer ${VALID_TOKEN}` })()).toBeUndefined()
  })

  it('trims surrounding whitespace from the token', () => {
    expect(callMiddleware('/mcp', { authorization: `Bearer   ${VALID_TOKEN}  ` })()).toBeUndefined()
  })

  describe('#105 P3 — анти-брутфорс по IP', () => {
    const wrong = (ip: string) => () => middleware({ _url: '/mcp', _headers: { authorization: 'Bearer wrong-token' }, _ip: ip })
    // Setup-итерации: глотаем ожидаемый 401, чтобы накопить счётчик неудач.
    const failN = (ip: string, n: number) => { for (let i = 0; i < n; i++) { try { wrong(ip)() } catch { /* expected 401 */ } } }

    it('после 10 неудач с одного IP отдаёт 429', () => {
      failN('9.9.9.9', 10)
      // 11-я попытка блокируется до сравнения токена
      expect(wrong('9.9.9.9')).toThrow(expect.objectContaining({ statusCode: 429 }))
    })

    it('429-ответ несёт Retry-After', () => {
      failN('8.8.8.8', 10)
      const event: FakeEvent = { _url: '/mcp', _headers: { authorization: 'Bearer wrong-token' }, _ip: '8.8.8.8' }
      expect(() => middleware(event)).toThrow(expect.objectContaining({ statusCode: 429 }))
      expect(event._responseHeaders?.['retry-after']).toBeDefined()
    })

    it('успешная auth сбрасывает счётчик неудач IP', () => {
      failN('7.7.7.7', 9)
      // верный токен с того же IP — проходит и чистит счётчик
      expect(middleware({ _url: '/mcp', _headers: { authorization: `Bearer ${VALID_TOKEN}` }, _ip: '7.7.7.7' })).toBeUndefined()
      // снова можно ошибаться без немедленного 429 (счётчик обнулён)
      expect(wrong('7.7.7.7')).toThrow(expect.objectContaining({ statusCode: 401 }))
    })

    it('лимит независим по IP', () => {
      failN('1.1.1.1', 10)
      expect(wrong('1.1.1.1')).toThrow(expect.objectContaining({ statusCode: 429 }))
      // другой IP не затронут
      expect(wrong('2.2.2.2')).toThrow(expect.objectContaining({ statusCode: 401 }))
    })

    it('верный токен не лимитируется даже после многих успехов', () => {
      for (let i = 0; i < 20; i++) {
        expect(middleware({ _url: '/mcp', _headers: { authorization: `Bearer ${VALID_TOKEN}` }, _ip: '3.3.3.3' })).toBeUndefined()
      }
    })

    it('после истечения окна (60с) попытки снова разрешены', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        failN('4.4.4.4', 10)
        expect(wrong('4.4.4.4')).toThrow(expect.objectContaining({ statusCode: 429 }))
        vi.setSystemTime(new Date('2026-01-01T00:01:01Z')) // +61с — окно истекло
        // снова обычный 401 (не 429): старые неудачи выпали из окна
        expect(wrong('4.4.4.4')).toThrow(expect.objectContaining({ statusCode: 401 }))
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('missing-header не засчитывается за неудачу (не накручивает брутфорс-счётчик)', () => {
      for (let i = 0; i < 20; i++) {
        // без Authorization → 401 Missing, но счётчик неудач НЕ растёт
        expect(() => middleware({ _url: '/mcp', _headers: {}, _ip: '5.5.5.5' }))
          .toThrow(expect.objectContaining({ statusCode: 401, message: 'Missing Authorization header' }))
      }
      // следующий неверный токен — всё ещё 401 (не 429), т.к. missing-header не считались
      expect(wrong('5.5.5.5')).toThrow(expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }))
    })
  })
})
