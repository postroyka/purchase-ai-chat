import { describe, it, expect } from 'vitest';
import { scoreResult, checkVatDirection, normName } from '../eval/score.js';

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

describe('scoreResult — error-путь (как эталонный RUB-счёт)', () => {
  const expected = { fixture: 'etalon-invoice.pdf', expect: 'error', error: 'unsupported_currency' };

  it('верный error-код → pass', () => {
    const r = scoreResult({ error: 'unsupported_currency', message: 'RUB не поддерживается' }, expected);
    expect(r.pass).toBe(true);
    expect(r.fixture).toBe('etalon-invoice.pdf');
  });

  it('другой error-код → fail', () => {
    const r = scoreResult({ error: 'supplier_not_found' }, expected);
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
