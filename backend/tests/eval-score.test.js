import { describe, it, expect } from 'vitest';
import { scoreResult, checkVatDirection, normName, summarize } from '../eval/score.js';

describe('checkVatDirection (ловушка НДС из #58)', () => {
  it('÷1.2 — верно (ok)', () => {
    // 120 с НДС → 100 без НДС
    const r = checkVatDirection(100, 120);
    expect(r.ok).toBe(true);
    expect(r.gotCloserTo).toBe('divide_by_1.2');
    expect(r.correct).toBe(100);
  });

  it('×0.8 — ловится как неверно', () => {
    // баг: 120 × 0.8 = 96 вместо 120 / 1.2 = 100
    const r = checkVatDirection(96, 120);
    expect(r.ok).toBe(false);
    expect(r.gotCloserTo).toBe('multiply_by_0.8');
    expect(r.wrong).toBe(96);
  });

  it('нет hint → null (проверка пропускается)', () => {
    expect(checkVatDirection(100, null)).toBeNull();
    expect(checkVatDirection(null, 120)).toBeNull();
  });
});

describe('normName', () => {
  it('игнорирует регистр, кавычки и лишние пробелы', () => {
    expect(normName('  Клей "Wellton",  10 кг ')).toBe('клей wellton 10 кг');
  });
});

describe('scoreResult — error-путь (как эталонный РФ-поставщик)', () => {
  // #97: отказ ожидается по РЕКВИЗИТАМ поставщика (foreign_supplier), а не по валюте.
  const expected = { fixture: 'etalon-invoice.pdf', expect: 'error', error: 'foreign_supplier' };

  it('верный error-код → pass', () => {
    const r = scoreResult({ error: 'foreign_supplier', message: 'РФ-реквизиты ИНН/КПП' }, expected);
    expect(r.pass).toBe(true);
    expect(r.fixture).toBe('etalon-invoice.pdf');
  });

  it('отказ по валюте вместо реквизитов → fail (#97: сигнал — ИНН/КПП, не валюта)', () => {
    const r = scoreResult({ error: 'unsupported_currency' }, expected);
    expect(r.pass).toBe(false);
  });

  it('агент СОЗДАЛ сделку вместо отказа → fail', () => {
    const r = scoreResult({ deal: { dealId: '777' } }, expected);
    expect(r.pass).toBe(false);
    const dealCheck = r.checks.find((c) => c.name === 'сделка не создана');
    expect(dealCheck.ok).toBe(false);
  });
});

describe('scoreResult — deal-путь (happy-path BYN)', () => {
  const expected = {
    fixture: 'byn-ok.pdf',
    expect: 'deal',
    currency: 'BYN',
    supplier: { unp: '191234567' },
    items: [
      { name: 'Цемент М500', priceExclVat: 100, quantity: 10, priceInclVatHint: 120 },
    ],
  };

  const goodActual = {
    currency: 'BYN',
    supplier: { unp: '191234567', name: 'ООО Поставщик' },
    items: [{ name: 'Цемент М500 (мешок)', priceExclVat: 100, quantity: 10 }],
    deal: { dealId: 'd-1' },
  };

  it('всё верно → pass', () => {
    expect(scoreResult(goodActual, expected).pass).toBe(true);
  });

  it('неверная валюта → fail', () => {
    const r = scoreResult({ ...goodActual, currency: 'USD' }, expected);
    expect(r.pass).toBe(false);
  });

  it('НДС посчитан как ×0.8 → fail (ловушка #58)', () => {
    const bad = { ...goodActual, items: [{ ...goodActual.items[0], priceExclVat: 96 }] };
    const r = scoreResult(bad, expected);
    expect(r.pass).toBe(false);
    const vatCheck = r.checks.find((c) => c.name.includes('направление НДС'));
    expect(vatCheck.ok).toBe(false);
  });

  it('дробное/иное количество → fail', () => {
    const bad = { ...goodActual, items: [{ ...goodActual.items[0], quantity: 9 }] };
    expect(scoreResult(bad, expected).pass).toBe(false);
  });

  it('неверный УНП → fail', () => {
    const bad = { ...goodActual, supplier: { unp: '999999999' } };
    expect(scoreResult(bad, expected).pass).toBe(false);
  });

  it('лишняя/недостающая позиция → fail', () => {
    const bad = { ...goodActual, items: [] };
    expect(scoreResult(bad, expected).pass).toBe(false);
  });

  it('неожиданный error на deal-фикстуре → fail', () => {
    const r = scoreResult({ error: 'tool_unavailable' }, expected);
    expect(r.pass).toBe(false);
  });
});

describe('summarize — агрегатная метрика (#93)', () => {
  // summarize() работает над выводом scoreResult(); строим объекты вручную, чтобы метрика
  // тестировалась независимо от внутреннего числа чеков scoreResult.
  const R = (pass, checks) => ({ fixture: 'f', pass, checks });

  it('пустой набор → нули, проценты null', () => {
    const s = summarize([]);
    expect(s.fixtures).toEqual({ passed: 0, total: 0 });
    expect(s.checks).toEqual({ passed: 0, total: 0, pct: null });
    expect(s.vat).toEqual({ divideBy1_2: 0, multiplyBy0_8: 0, total: 0, errorPct: null });
  });

  it('доля прошедших фикстур и совпавших полей', () => {
    const s = summarize([
      R(true, [{ name: 'a', ok: true }, { name: 'b', ok: true }]),
      R(false, [{ name: 'a', ok: true }, { name: 'b', ok: false }]),
    ]);
    expect(s.fixtures).toEqual({ passed: 1, total: 2 });
    expect(s.checks).toEqual({ passed: 3, total: 4, pct: 75 });
  });

  it('частота НДС-ошибки ×0.8 vs ÷1.2', () => {
    const s = summarize([
      R(true, [{ name: 'НДС', ok: true, vat: 'divide_by_1.2' }]),
      R(false, [{ name: 'НДС', ok: false, vat: 'multiply_by_0.8' }]),
      R(false, [{ name: 'НДС', ok: false, vat: 'multiply_by_0.8' }]),
    ]);
    expect(s.vat.divideBy1_2).toBe(1);
    expect(s.vat.multiplyBy0_8).toBe(2);
    expect(s.vat.total).toBe(3);
    expect(s.vat.errorPct).toBe(66.67); // round2(2/3 × 100)
  });

  it('интегрируется с реальным scoreResult — НДС-тег попадает в метрику', () => {
    const dealExpected = {
      fixture: 'byn-ok.pdf', expect: 'deal',
      items: [{ name: 'Цемент', priceExclVat: 100, priceInclVatHint: 120 }],
    };
    // агент посчитал ×0.8 (96) — ошибка должна быть засчитана в vat.multiplyBy0_8
    const r = scoreResult({ items: [{ name: 'Цемент', priceExclVat: 96 }] }, dealExpected);
    const s = summarize([r]);
    expect(s.vat.multiplyBy0_8).toBe(1);
    expect(s.vat.divideBy1_2).toBe(0);
  });
});
