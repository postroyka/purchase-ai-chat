import { describe, it, expect } from 'vitest'
import { computeMatchingReasons, MATCHING_REASON_LABELS } from '../app/utils/matching-reasons'

const snap = (outcomes: { name: string, count: number }[], warnings: { name: string, count: number }[] = []) =>
  ({ outcomes, warnings })

describe('computeMatchingReasons (#182 MCP)', () => {
  it('folds matching codes from outcomes + warnings, ranked desc, zeros dropped', () => {
    const r = computeMatchingReasons(snap(
      [
        { name: 'ok', count: 50 }, // not a matching reason → excluded
        { name: 'supplier_not_found', count: 4 },
        { name: 'foreign_supplier', count: 7 },
        { name: 'contract_not_found', count: 1 }
      ],
      [{ name: 'no_items_matched', count: 3 }, { name: 'items_without_article', count: 9 }]
    ))
    expect(r).toEqual([
      { name: 'foreign_supplier', count: 7 },
      { name: 'supplier_not_found', count: 4 },
      { name: 'no_items_matched', count: 3 },
      { name: 'contract_not_found', count: 1 }
    ])
    // unsupported_currency had no count → dropped; non-matching codes (ok, items_without_article) excluded
    expect(r.find(x => x.name === 'unsupported_currency')).toBeUndefined()
    expect(r.find(x => x.name === 'ok')).toBeUndefined()
  })

  it('returns [] for a null snapshot or all-zero counts', () => {
    expect(computeMatchingReasons(null)).toEqual([])
    expect(computeMatchingReasons(snap([{ name: 'ok', count: 9 }], []))).toEqual([])
  })

  it('every reason code it can emit has a Russian label (no typo drift vs backend keys)', () => {
    const all = computeMatchingReasons(snap(
      [
        { name: 'supplier_not_found', count: 1 },
        { name: 'contract_not_found', count: 1 },
        { name: 'foreign_supplier', count: 1 },
        { name: 'unsupported_currency', count: 1 }
      ],
      [{ name: 'no_items_matched', count: 1 }]
    ))
    for (const reason of all) expect(MATCHING_REASON_LABELS[reason.name]).toBeTruthy()
  })
})
