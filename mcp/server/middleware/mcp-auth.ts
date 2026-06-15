import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { createError, defineEventHandler, getHeader, getRequestURL } from 'h3'

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event)

  // Only guard /mcp and /mcp/* — paths like /mcphacked must not bypass auth
  // but also must not require it (404 from the router is fine).
  if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return

  // .trim(): a stray space in the env value would otherwise pass the length gate but never
  // match the (trimmed) request token — a confusing 401-for-everyone operational trap.
  const expected = useRuntimeConfig().mcpAuthToken?.trim()
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

  // Reject a too-short (brute-forceable) token as misconfiguration (#105): the contract is
  // `openssl rand -hex 32` (64 hex chars). Fail closed rather than guard /mcp with a weak
  // secret. Same opaque 503 — never reveal token specifics to anonymous callers.
  if (expected.length < 32) {
    throw createError({
      statusCode: 503,
      statusMessage: 'MCP endpoint is not available',
    })
  }

  const header = getHeader(event, 'authorization')
  if (!header) {
    throw createError({ statusCode: 401, statusMessage: 'Missing Authorization header' })
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()

  if (!token || !timingSafeEqual(token, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid bearer token' })
  }
})

function timingSafeEqual(a: string, b: string): boolean {
  // Hash both sides to a fixed 32-byte digest so comparison is constant-time with no
  // length leak (#105) — avoids both crypto.timingSafeEqual's equal-length throw and the
  // old early length short-circuit. SHA-256 collision resistance ⇒ equal digests mean
  // equal tokens for auth.
  return cryptoTimingSafeEqual(sha256(a), sha256(b))
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest()
}
