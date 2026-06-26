import { describe, it, expect } from 'vitest'
import { stripHostileChars } from '../app/utils/content-safe'

describe('stripHostileChars (#320 follow-up — Trojan Source санитизация)', () => {
  it('вырезает bidi-оверрайды (RLO/PDF) и isolates (LRI/PDI)', () => {
    expect(stripHostileChars('A\u202eB\u202cC')).toBe('ABC')
    expect(stripHostileChars('\u2066x\u2069')).toBe('x')
  })

  it('вырезает zero-width и BOM', () => {
    expect(stripHostileChars('a\u200bb\u200c\u200dc\ufeff')).toBe('abc')
  })

  it('вырезает C0-управляющие, но сохраняет перевод строки и таб', () => {
    expect(stripHostileChars('a\x07b')).toBe('ab')
    expect(stripHostileChars('строка1\nстрока2\tтаб')).toBe('строка1\nстрока2\tтаб')
  })

  it('обычный текст не меняется; не-строка → пустая строка', () => {
    expect(stripHostileChars('Распознан поставщик X, 3 позиции')).toBe('Распознан поставщик X, 3 позиции')
    expect(stripHostileChars(null)).toBe('')
    expect(stripHostileChars(undefined)).toBe('')
    expect(stripHostileChars(42)).toBe('')
  })
})
