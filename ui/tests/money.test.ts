import { describe, it, expect } from 'vitest'
import { money } from '../app/utils/money'

describe('money (формат денег /metrics)', () => {
  it('пробел-разряды, точка-десятичные, 2 знака, валюта строчным суффиксом', () => {
    expect(money(3.62, 'usd')).toBe('3.62 usd')
    expect(money(55123.62, 'usd')).toBe('55 123.62 usd')
    expect(money(66356.49, 'byn')).toBe('66 356.49 byn')
  })

  it('паддинг до 2 знаков (чинит исходный misread "$3,561" → "3.56 usd")', () => {
    expect(money(3.561, 'usd')).toBe('3.56 usd')
    expect(money(3.6, 'usd')).toBe('3.60 usd')
    expect(money(3, 'byn')).toBe('3.00 byn')
  })

  it('округление до 2 знаков (half-up)', () => {
    expect(money(3.625, 'usd')).toBe('3.63 usd')
    expect(money(3.624, 'usd')).toBe('3.62 usd')
  })

  it('ноль и отрицательные', () => {
    expect(money(0, 'usd')).toBe('0.00 usd')
    expect(money(-5, 'byn')).toBe('-5.00 byn')
    expect(money(-1234.5, 'usd')).toBe('-1 234.50 usd')
  })

  it('суб-единичные суммы — до 4 знаков, не схлопываются в "0.00" (стоимость модели)', () => {
    expect(money(0.0021, 'usd')).toBe('0.0021 usd')
    expect(money(0.27, 'usd')).toBe('0.27 usd')
    expect(money(0.5, 'byn')).toBe('0.50 byn')
  })

  it('глубоко околонулевое отрицательное → "0.00", без "-0.00"', () => {
    expect(money(-0.00004, 'byn')).toBe('0.00 byn')
  })

  it('произвольная валюта (статистика сделок #201) — суффикс в нижнем регистре', () => {
    expect(money(12345.67, 'RUB')).toBe('12 345.67 rub')
    expect(money(990, 'EUR')).toBe('990.00 eur')
  })
})
