import { describe, it, expect } from 'vitest'
import { perfDiagNotes } from '../app/utils/perf-diag'

describe('perfDiagNotes (#279)', () => {
  it('нет result / нет feedback / не массив → []', () => {
    expect(perfDiagNotes(null)).toEqual([])
    expect(perfDiagNotes(undefined)).toEqual([])
    expect(perfDiagNotes({})).toEqual([])
    expect(perfDiagNotes({ feedback: 'x' })).toEqual([])
    expect(perfDiagNotes('строка')).toEqual([])
  })

  it('берёт только kind:"perf" с непустым note', () => {
    const result = {
      feedback: [
        { kind: 'perf', note: 'много ходов на поиск артикула' },
        { kind: 'problem', note: 'это не perf' },
        { kind: 'perf', note: '   ' }, // пустой после trim → отброшен
        { kind: 'perf' }, // нет note → отброшен
        { kind: 'perf', note: 'НДС считал дважды' }
      ]
    }
    expect(perfDiagNotes(result)).toEqual([
      'много ходов на поиск артикула',
      'НДС считал дважды'
    ])
  })

  it('игнорирует мусорные записи feedback (null / не-объект)', () => {
    const result = { feedback: [null, 42, 'str', { kind: 'perf', note: 'ок' }] }
    expect(perfDiagNotes(result)).toEqual(['ок'])
  })

  it('санитизация: вырезает bidi/zero-width/control (Trojan Source)', () => {
    const dirty = 'a\u202eb\u200bcd' // bidi-override + zero-width
    expect(perfDiagNotes({ feedback: [{ kind: 'perf', note: dirty }] })).toEqual(['abcd'])
  })

  it('после вырезания пустой note отбрасывается', () => {
    const onlyHostile = '\u202e\u200b\u2066'
    expect(perfDiagNotes({ feedback: [{ kind: 'perf', note: onlyHostile }] })).toEqual([])
  })

  it('cap: не более 5 записей', () => {
    const feedback = Array.from({ length: 8 }, (_, i) => ({ kind: 'perf', note: `note-${i}` }))
    const out = perfDiagNotes({ feedback })
    expect(out).toHaveLength(5)
    expect(out[0]).toBe('note-0')
    expect(out[4]).toBe('note-4')
  })

  it('cap: длина note усечена до 2000 символов', () => {
    const long = 'x'.repeat(5000)
    const out = perfDiagNotes({ feedback: [{ kind: 'perf', note: long }] })
    expect(out[0]).toHaveLength(2000)
  })
})
