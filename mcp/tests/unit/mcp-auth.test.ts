import { describe, it, expect } from 'vitest'

// Unit-test the timing-safe comparison logic extracted from mcp-auth.ts
// We test the logic in isolation without spinning up a Nitro server.

import { Buffer } from 'node:buffer'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

describe('timingSafeEqual', () => {
  it('returns true for identical tokens', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different tokens of equal length', () => {
    expect(timingSafeEqual('aaaaaa', 'bbbbbb')).toBe(false)
  })

  it('returns false for tokens of different length (no throw)', () => {
    expect(timingSafeEqual('short', 'muchlonger')).toBe(false)
  })

  it('returns false for empty vs non-empty', () => {
    expect(timingSafeEqual('', 'token')).toBe(false)
  })
})

describe('parseBearer', () => {
  it('extracts token from valid Authorization header', () => {
    expect(parseBearer('Bearer mytoken123')).toBe('mytoken123')
  })

  it('is case-insensitive on "bearer"', () => {
    expect(parseBearer('BEARER mytoken')).toBe('mytoken')
  })

  it('returns null for missing header', () => {
    expect(parseBearer(undefined)).toBeNull()
  })

  it('returns null for malformed header (no space)', () => {
    expect(parseBearer('Bearertoken')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseBearer('')).toBeNull()
  })
})

describe('auth flow integration', () => {
  const EXPECTED = 'secret-token-1234'

  function checkAuth(header: string | undefined): boolean {
    if (!EXPECTED || EXPECTED === 'replace-with-secure-token') return false
    const token = parseBearer(header)
    if (!token) return false
    return timingSafeEqual(token, EXPECTED)
  }

  it('accepts correct token', () => {
    expect(checkAuth(`Bearer ${EXPECTED}`)).toBe(true)
  })

  it('rejects wrong token', () => {
    expect(checkAuth('Bearer wrong-token-xxxx')).toBe(false)
  })

  it('rejects missing header', () => {
    expect(checkAuth(undefined)).toBe(false)
  })

  it('rejects placeholder token', () => {
    // Simulates misconfigured deployment — placeholder must not grant access
    const badSecret = 'replace-with-secure-token'
    const badCheck = (h: string | undefined) => {
      if (!badSecret || badSecret === 'replace-with-secure-token') return false
      const token = parseBearer(h)
      if (!token) return false
      return timingSafeEqual(token, badSecret)
    }
    expect(badCheck('Bearer replace-with-secure-token')).toBe(false)
  })
})
