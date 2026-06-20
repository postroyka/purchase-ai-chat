import { describe, it, expect } from 'vitest'
import { mmss, humanMs } from '../app/utils/format-duration'

describe('format-duration (#замеры)', () => {
  it('mmss: mm:ss с паддингом, минуты не обрезаются', () => {
    expect(mmss(0)).toBe('00:00')
    expect(mmss(9000)).toBe('00:09')
    expect(mmss(90000)).toBe('01:30')
    expect(mmss(3661000)).toBe('61:01')
    expect(mmss(-500)).toBe('00:00')
  })

  it('humanMs: мс / с (1 знак, <60с) / мин+с (≥60с)', () => {
    expect(humanMs(740)).toBe('740 мс')
    expect(humanMs(45300)).toBe('45.3 с')
    expect(humanMs(74800)).toBe('1 мин 15 с') // 74.8 с > 60 с → минуты+секунды
    expect(humanMs(80200)).toBe('1 мин 20 с')
    expect(humanMs(120000)).toBe('2 мин')
    expect(humanMs(-1)).toBe('—')
    expect(humanMs(Number.NaN)).toBe('—')
  })
})
