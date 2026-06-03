import { describe, it, expect } from 'vitest'
import { pick, toNumber, toBool } from '../../server/utils/wire-coerce'

describe('pick', () => {
  it('returns camelCase value when present', () => {
    expect(pick<number>({ id: 42 }, 'id', 'ID')).toBe(42)
  })

  it('falls back to UPPERCASE when camelCase is absent', () => {
    expect(pick<number>({ ID: 7 }, 'id', 'ID')).toBe(7)
  })

  it('falls through null camelCase to UPPERCASE value', () => {
    // null ?? upperVal → upperVal (documented asymmetry)
    expect(pick<number>({ id: null, ID: 5 }, 'id', 'ID')).toBe(5)
  })

  it('returns null when neither key is present', () => {
    expect(pick({}, 'id', 'ID')).toBeNull()
  })

  it('does not traverse prototype', () => {
    const obj = Object.create({ id: 'proto' })
    expect(pick(obj, 'id', 'ID')).toBeNull()
  })
})

describe('toNumber', () => {
  it('parses string integer', () => {
    expect(toNumber('42')).toBe(42)
  })

  it('passes through number', () => {
    expect(toNumber(7)).toBe(7)
  })

  it('returns null for empty string', () => {
    expect(toNumber('')).toBeNull()
  })

  it('returns null for null', () => {
    expect(toNumber(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(toNumber(undefined)).toBeNull()
  })

  it('returns null for non-numeric string', () => {
    expect(toNumber('abc')).toBeNull()
  })

  it('truncates decimal strings via parseInt', () => {
    expect(toNumber('3.7')).toBe(3)
  })
})

describe('toBool', () => {
  it('returns true for "Y"', () => {
    expect(toBool('Y')).toBe(true)
  })

  it('returns false for "N"', () => {
    expect(toBool('N')).toBe(false)
  })

  it('returns false for anything else', () => {
    expect(toBool('yes')).toBe(false)
    expect(toBool(1)).toBe(false)
    expect(toBool(null)).toBe(false)
    expect(toBool(undefined)).toBe(false)
  })
})
