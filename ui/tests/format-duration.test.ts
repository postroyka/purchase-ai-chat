import { describe, it, expect } from 'vitest'
import { mmss, humanMs, timingLine } from '../app/utils/format-duration'

describe('format-duration (#замеры)', () => {
  it('mmss: mm:ss с паддингом, минуты не обрезаются, мусор → 00:00', () => {
    expect(mmss(0)).toBe('00:00')
    expect(mmss(9000)).toBe('00:09')
    expect(mmss(90000)).toBe('01:30')
    expect(mmss(3661000)).toBe('61:01')
    expect(mmss(-500)).toBe('00:00')
    expect(mmss(Number.NaN)).toBe('00:00')
  })

  it('humanMs: мс / с (1 знак, <60с) / мин+с (≥60с)', () => {
    expect(humanMs(740)).toBe('740 мс')
    expect(humanMs(45300)).toBe('45.3 с')
    expect(humanMs(74800)).toBe('1 мин 15 с')
    expect(humanMs(80200)).toBe('1 мин 20 с')
    expect(humanMs(120000)).toBe('2 мин')
    expect(humanMs(-1)).toBe('—')
    expect(humanMs(Number.NaN)).toBe('—')
  })

  it('humanMs: граница 60с — не показываем вводящее в заблуждение "60.0 с"', () => {
    expect(humanMs(60000)).toBe('1 мин')
    expect(humanMs(59950)).toBe('1 мин') // округлилось бы в "60.0 с" → минуты
    expect(humanMs(59940)).toBe('59.9 с') // ниже границы — секунды
  })

  it('timingLine: всего / +скорость / +агент / +извлечение; null длительность → ""', () => {
    expect(timingLine({ durationMs: null })).toBe('')
    expect(timingLine({ durationMs: 48500, agentMs: 44200 })).toBe('⏱ всего 48.5 с · агент 44.2 с') // без speed
    expect(timingLine({ durationMs: 80200, speed: 'normal' })).toBe('⏱ всего 1 мин 20 с — норма')
    expect(timingLine({ durationMs: 120000, speed: 'slow', agentMs: 110000, extractMethod: 'ocr' }))
      .toBe('⏱ всего 2 мин — медленно · агент 1 мин 50 с · извлечение: ocr')
    // агент отсутствует (null, напр. ошибка) — секцию агента не показываем
    expect(timingLine({ durationMs: 5000, speed: 'fast', extractMethod: 'pdftotext' }))
      .toBe('⏱ всего 5.0 с — быстро · извлечение: pdftotext')
  })

  it('timingLine: извлечение показывает метод + точное время extractMs (#203.2)', () => {
    expect(timingLine({ durationMs: 120000, speed: 'slow', agentMs: 110000, extractMethod: 'ocr', extractMs: 2300 }))
      .toBe('⏱ всего 2 мин — медленно · агент 1 мин 50 с · извлечение: ocr 2.3 с')
    // extractMs без метода (метод null) — секцию извлечения не показываем вовсе
    expect(timingLine({ durationMs: 5000, extractMethod: null, extractMs: 900 }))
      .toBe('⏱ всего 5.0 с')
  })
})
