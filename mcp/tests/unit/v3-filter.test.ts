import { describe, it, expect } from 'vitest'
import { toV3Filter } from '../../server/utils/v3-filter'

describe('toV3Filter', () => {
  it('equality: plain key → 2-tuple', () => {
    expect(toV3Filter({ taskId: 7 })).toEqual([['taskId', 7]])
  })

  it('not-equal prefix ! → ["<>", field, value]', () => {
    expect(toV3Filter({ '!status': 'closed' })).toEqual([['<>', 'status', 'closed']])
  })

  it('not-equal prefix != → ["<>", field, value]', () => {
    expect(toV3Filter({ '!=status': 'closed' })).toEqual([['<>', 'status', 'closed']])
  })

  it('contains prefix % → ["contains", field, value]', () => {
    expect(toV3Filter({ '%title': 'foo' })).toEqual([['contains', 'title', 'foo']])
  })

  it('comparison prefix >= → [">=", field, value]', () => {
    expect(toV3Filter({ '>=createdAt': '2025-01-01' })).toEqual([['>=', 'createdAt', '2025-01-01']])
  })

  it('longer prefix wins: >= over >', () => {
    const result = toV3Filter({ '>=count': 3 })
    expect(result[0]![0]).toBe('>=')
  })

  it('multiple keys preserve insertion order', () => {
    const result = toV3Filter({ taskId: 7, '!status': 'closed', '%title': 'q' })
    expect(result).toEqual([
      ['taskId', 7],
      ['<>', 'status', 'closed'],
      ['contains', 'title', 'q'],
    ])
  })

  it('drops __proto__ key silently', () => {
    const filter: Record<string, unknown> = {}
    Object.defineProperty(filter, '__proto__', { value: 'evil', enumerable: true })
    // JSON.parse round-trip makes __proto__ an own enumerable key
    const parsed = JSON.parse('{"__proto__": "evil", "taskId": 1}') as Record<string, unknown>
    expect(toV3Filter(parsed)).toEqual([['taskId', 1]])
  })

  it('drops !__proto__ key silently', () => {
    const parsed = JSON.parse('{"!__proto__": "evil"}') as Record<string, unknown>
    expect(toV3Filter(parsed)).toEqual([])
  })

  it('handles empty filter', () => {
    expect(toV3Filter({})).toEqual([])
  })
})
