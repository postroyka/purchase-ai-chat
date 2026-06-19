import { describe, it, expect } from 'vitest'
import { fileBadge, jobBadge, fileSucceeded, dealIdOf, type ResultFile } from '../app/utils/result-badges'

const withDeal = (id: string | number = '5', status: ResultFile['status'] = 'done'): ResultFile =>
  ({ status, result: { deal: { dealId: id } } })
const noDeal = (status: ResultFile['status'] = 'done'): ResultFile =>
  ({ status, result: { error: 'supplier_not_found' } })

describe('result-badges (#192)', () => {
  it('dealIdOf handles missing / empty / coerced ids', () => {
    expect(dealIdOf(withDeal('7'))).toBe('7')
    expect(dealIdOf(withDeal(42))).toBe('42')
    expect(dealIdOf({ status: 'done', result: {} })).toBeNull()
    expect(dealIdOf({ status: 'done', result: { deal: { dealId: '  ' } } })).toBeNull()
    expect(dealIdOf({ status: 'done' })).toBeNull()
  })

  it('fileSucceeded only when done AND a deal exists', () => {
    expect(fileSucceeded(withDeal())).toBe(true)
    expect(fileSucceeded(noDeal())).toBe(false) // done, no deal
    expect(fileSucceeded({ status: 'done', result: { deal: { dealId: '' } } })).toBe(false)
    expect(fileSucceeded(withDeal('5', 'processing'))).toBe(false) // not done yet
  })

  it('fileBadge: done+deal → Готово; done+no-deal → Без сделки; else status default', () => {
    expect(fileBadge(withDeal())).toEqual({ label: 'Готово', color: 'air-primary-success' })
    expect(fileBadge(noDeal())).toEqual({ label: 'Без сделки', color: 'air-primary-warning' })
    expect(fileBadge({ status: 'error' })).toEqual({ label: 'Ошибка', color: 'air-primary-alert' })
    expect(fileBadge({ status: 'processing' })).toEqual({ label: 'Обработка…', color: 'air-primary' })
  })

  it('jobBadge: all-deal → Готово; none → Без сделок; some → Частично; non-done → status default', () => {
    expect(jobBadge('done', [withDeal(), withDeal()])).toEqual({ label: 'Готово', color: 'air-primary-success' })
    expect(jobBadge('done', [noDeal(), noDeal()])).toEqual({ label: 'Без сделок', color: 'air-primary-warning' })
    expect(jobBadge('done', [withDeal(), noDeal()])).toEqual({ label: 'Частично', color: 'air-primary-warning' })
    expect(jobBadge('error', [noDeal('error')])).toEqual({ label: 'Ошибка', color: 'air-primary-alert' })
    expect(jobBadge('processing', [])).toEqual({ label: 'Обработка…', color: 'air-primary' })
  })
})
