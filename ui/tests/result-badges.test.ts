import { describe, it, expect } from 'vitest'
import { fileBadge, jobBadge, fileSucceeded, dealIdOf, outcomeCodeOf, notEnteredCount, type ResultFile } from '../app/utils/result-badges'

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
    // #cancel: остановленный импорт — отменённые файлы
    expect(fileBadge({ status: 'cancelled' })).toEqual({ label: 'Отменено', color: 'air-secondary' })
  })

  it('jobBadge: all-deal → Готово; none → Без сделок; some → Частично; non-done → status default', () => {
    expect(jobBadge('done', [withDeal(), withDeal()])).toEqual({ label: 'Готово', color: 'air-primary-success' })
    expect(jobBadge('done', [noDeal(), noDeal()])).toEqual({ label: 'Без сделок', color: 'air-primary-warning' })
    expect(jobBadge('done', [withDeal(), noDeal()])).toEqual({ label: 'Частично', color: 'air-primary-warning' })
    expect(jobBadge('error', [noDeal('error')])).toEqual({ label: 'Ошибка', color: 'air-primary-alert' })
    expect(jobBadge('processing', [])).toEqual({ label: 'Обработка…', color: 'air-primary' })
  })

  it('outcomeCodeOf: код из result.error; не-строка/отсутствие → пусто; обрезка длины (#221)', () => {
    expect(outcomeCodeOf(noDeal())).toBe('supplier_not_found')
    expect(outcomeCodeOf({ status: 'error', result: { error: '  tool_unavailable  ' } })).toBe('tool_unavailable')
    expect(outcomeCodeOf(withDeal())).toBe('') // успех — нет кода
    expect(outcomeCodeOf({ status: 'done', result: {} })).toBe('')
    expect(outcomeCodeOf({ status: 'done', result: { error: 123 } })).toBe('') // не строка
    expect(outcomeCodeOf({ status: 'done' })).toBe('')
    expect(outcomeCodeOf({ status: 'error', result: { error: 'x'.repeat(100) } })).toHaveLength(64) // cap
  })

  it('notEnteredCount (#329-A): сумма itemsWithoutArticle + unmatchedArticles.length, мусор → 0', () => {
    // нет артикула (2) + артикул не в каталоге (2 шт) = 4
    expect(notEnteredCount({ status: 'done', result: { matching: { itemsWithoutArticle: 2, unmatchedArticles: ['A', 'B'] } } })).toBe(4)
    // только без артикула
    expect(notEnteredCount({ status: 'done', result: { matching: { itemsWithoutArticle: 3 } } })).toBe(3)
    // только не в каталоге
    expect(notEnteredCount({ status: 'done', result: { matching: { unmatchedArticles: ['X'] } } })).toBe(1)
    // всё сопоставлено → 0
    expect(notEnteredCount({ status: 'done', result: { matching: { itemsWithoutArticle: 0, unmatchedArticles: [] } } })).toBe(0)
    // защита от мусора: отрицательное/нечисло/не-массив/отсутствие matching
    expect(notEnteredCount({ status: 'done', result: { matching: { itemsWithoutArticle: -5, unmatchedArticles: 'oops' } } })).toBe(0)
    expect(notEnteredCount({ status: 'done', result: { matching: { itemsWithoutArticle: 1.9 } } })).toBe(1) // trunc
    expect(notEnteredCount({ status: 'done', result: {} })).toBe(0)
    expect(notEnteredCount({ status: 'done' })).toBe(0)
  })
})
