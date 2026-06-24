import { createError, defineEventHandler, getHeader, getRequestIP, getRequestURL, setResponseHeader } from 'h3'
import { timingSafeEqualStr } from '~/server/utils/auth-helpers'
import { useLogger } from '~/server/utils/logger'

// RFC 6750 §3 `realm` for the webhook-mode Bearer challenge. Identifies the
// protection space in the `WWW-Authenticate` header so a spec-following MCP
// client can present the right credential.
const WWW_AUTH_REALM = 'bx24-template-mcp'

// #105 (P3): анти-брутфорс на webhook-токен /mcp. Считаем ТОЛЬКО НЕУДАЧНЫЕ попытки (неверный токен)
// по IP в скользящем окне; легитимный backend-агент с верным токеном не лимитируется (успех очищает
// счётчик). Процесс-локальная карта (single-instance, см. oauth-rate-limit.ts), LRU-ограничена, чтобы
// ротация IP не вымывала «горячий» бакет. /mcp в проде во внутренней сети (procure-net) — это
// defence-in-depth поверх токена. Сброс окна между тестами — _resetMcpAuthRateLimitForTests().
const FAIL_WINDOW_MS = 60_000
const MAX_FAILS_PER_WINDOW = 10
const MAX_TRACKED_IPS = 10_000
const authFails = new Map<string, number[]>()

/** Test hook — clears all brute-force buckets. */
export function _resetMcpAuthRateLimitForTests(): void {
  authFails.clear()
}

/** Sliding-window failure count for an IP (with LRU touch). Returns the live bucket. */
function failBucket(ip: string, now: number): number[] {
  let bucket = authFails.get(ip)
  if (bucket) {
    authFails.delete(ip) // re-insert at MRU end (Map keeps insertion order)
  }
  else {
    if (authFails.size >= MAX_TRACKED_IPS) {
      const lru = authFails.keys().next().value
      if (lru !== undefined) authFails.delete(lru)
    }
    bucket = []
  }
  authFails.set(ip, bucket)
  while (bucket.length > 0 && bucket[0]! < now - FAIL_WINDOW_MS) bucket.shift()
  return bucket
}

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event)

  // Only guard /mcp and /mcp/* — paths like /mcphacked must not bypass auth
  // but also must not require it (404 from the router is fine).
  if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return

  // When OAuth is on, the toolkit-level middleware in `server/mcp/index.ts`
  // owns Bearer-to-tenant resolution (it also needs to wrap `next()` in an
  // ALS scope, which an h3-level middleware can't do). Defence-in-depth:
  // we don't trust the toolkit middleware to register correctly under
  // HMR or a failing module load — refuse the request HERE if there's
  // no `Authorization: Bearer …` shape at all, then yield for the
  // toolkit middleware to do the actual cryptographic validation. Worst
  // case if the toolkit middleware is missing: requests still get 401,
  // not an auth bypass.
  if (useRuntimeConfig().bitrix24OauthEnabled) {
    const header = getHeader(event, 'authorization')
    if (!header || !/^Bearer\s+\S/i.test(header)) {
      // §11 / RFC 6750 §3: every Bearer-auth 401 carries WWW-Authenticate
      // with the errorCode. This branch fires BEFORE the toolkit
      // middleware in `server/mcp/index.ts` (which sets the same header
      // on its own deny paths), so it must set the header itself —
      // otherwise a no-Bearer request gets a bare 401 and the §11
      // contract is silently broken in production (caught by the #224
      // docker-smoke OAuth-on boot). BEARER-UNKNOWN matches the toolkit
      // middleware's bucket for an absent Bearer: indistinguishable from
      // one that was never minted.
      setResponseHeader(event, 'www-authenticate', 'Bearer error="invalid_token", errorCode="BEARER-UNKNOWN", error_description="Bearer required"')
      throw createError({ statusCode: 401, statusMessage: 'Bearer required', data: { errorCode: 'BEARER-UNKNOWN' } })
    }
    return
  }

  const expected = useRuntimeConfig().mcpAuthToken
  // Treat the `.env.example` placeholder as "not configured": an operator who
  // copied the example without running `openssl rand -hex 32` must not end up
  // with a guessable, publicly-documented token guarding /mcp.
  if (!expected || expected === 'replace-with-secure-token') {
    // Service-unavailable: not configured, not the caller's fault. Surfacing
    // 500 here would leak misconfiguration to anonymous callers.
    throw createError({
      statusCode: 503,
      statusMessage: 'MCP endpoint is not available',
    })
  }

  // #105 (P3): reject a too-short server token as "not configured". A 3-char token
  // would pass timingSafeEqual and guard /mcp with a guessable/brute-forceable
  // secret. The intended value is `openssl rand -hex 32` (64 chars); require ≥32 so
  // a typo/truncated MCP_AUTH_TOKEN can't silently weaken auth. Same 503 — don't
  // leak misconfiguration to anonymous callers.
  if (expected.length < 32) {
    throw createError({
      statusCode: 503,
      statusMessage: 'MCP endpoint is not available',
    })
  }

  // #105 (P3): анти-брутфорс. Если с этого IP уже было ≥ MAX_FAILS_PER_WINDOW неудачных попыток в
  // окне — отвергаем 429 до сравнения токена (тайминг-атаку/подбор не пускаем дальше). Засчитываются
  // ТОЛЬКО неудачи (неверный токен), успех очищает счётчик IP — поэтому легитимный агент с верным
  // токеном обычно не лимитируется. Оговорка: за общим прокси (один source-IP) счётчик IP — общий,
  // как в oauth-rate-limit.ts; в проде /mcp во внутренней procure-net, так что это defence-in-depth.
  const ip = getRequestIP(event) ?? '<unknown>'
  const now = Date.now()
  const fails = failBucket(ip, now)
  if (fails.length >= MAX_FAILS_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((fails[0]! + FAIL_WINDOW_MS - now) / 1000))
    void useLogger().warning('mcp.auth.deny.rate-limited', { ip, retryAfterSec }) // наблюдаемость (паритет с oauth-rate-limit)
    setResponseHeader(event, 'retry-after', retryAfterSec)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many failed auth attempts - retry later',
      data: { errorCode: 'RATE-LIMITED' },
    })
  }

  const header = getHeader(event, 'authorization')
  if (!header) {
    // RFC 6750 §3: a 401 from a Bearer-protected resource MUST carry a
    // `WWW-Authenticate: Bearer` challenge. When the request supplied NO
    // credentials at all, the spec says NOT to include an `error` code —
    // just the realm (and optionally `scope`). Spec-following MCP clients
    // use this to discover the auth scheme. The OAuth-on branch above sets
    // its own header with the §11 errorCode taxonomy; webhook mode uses
    // the plain realm challenge.
    setResponseHeader(event, 'www-authenticate', `Bearer realm="${WWW_AUTH_REALM}"`)
    throw createError({ statusCode: 401, statusMessage: 'Missing Authorization header' })
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()

  if (!token || !timingSafeEqualStr(token, expected)) {
    // RFC 6750 §3: credentials WERE supplied but are wrong → include
    // `error="invalid_token"` so the client knows to stop retrying with
    // the same value rather than re-prompting for a missing one.
    setResponseHeader(
      event,
      'www-authenticate',
      `Bearer realm="${WWW_AUTH_REALM}", error="invalid_token", error_description="Invalid bearer token"`,
    )
    fails.push(now) // #105 P3: засчитываем неудачную попытку для анти-брутфорса
    throw createError({ statusCode: 401, statusMessage: 'Invalid bearer token' })
  }

  // #105 (P3): успешная auth — очищаем счётчик неудач этого IP, чтобы редкие опечатки легитимного
  // клиента не накапливались к порогу.
  authFails.delete(ip)
})
