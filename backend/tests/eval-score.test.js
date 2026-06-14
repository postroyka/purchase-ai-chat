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

  it('ровно посередине (÷1.2 и ×0.8 равноудалены) → ok (ничья в пользу ÷1.2 по <=)', () => {
    // correct=100, wrong=96, середина=98: dCorrect == dWrong → ok:true (контракт оператора <=)
    const r = checkVatDirection(98, 120);
    expect(r.ok).toBe(true);
    expect(r.gotCloserTo).toBe('divide_by_1.2');
  });
});

describe('normName', () => {
  it('игнорирует регистр, кавычки и лишние пробелы', () => {
    expect(normName('  Клей "Wellton",  10 кг ')).toBe('клей wellton 10 кг');
  });

  it('дефис/тире приравнивается к пробелу', () => {
    expect(normName('Wellton-45')).toBe(normName('Wellton 45'));
    expect(normName('Клей—Момент')).toBe('клей момент');
  });

  it('русские «ёлочки» убираются', () => {
    expect(normName('Грунтовка «Бетоноконтакт»')).toBe('грунтовка бетоноконтакт');
  });

  it('null/undefined → пустая строка (без throw)', () => {
    expect(normName(null)).toBe('');
    expect(normName(undefined)).toBe('');
  });

  it('число → строка (контракт String(s ?? ""))', () => {
    expect(normName(42)).toBe('42');
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
    expect(dealCheck).toBeTruthy();
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
    expect(vatCheck).toBeTruthy();
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

  it('нет deal.dealId → fail (агент распознал, но сделку не создал — не ложно-зелёный)', () => {
    const noDeal = {
      currency: 'BYN',
      supplier: { unp: '191234567' },
      items: [{ name: 'Цемент М500', priceExclVat: 100, quantity: 10 }],
      // deal отсутствует
    };
    const r = scoreResult(noDeal, expected);
    expect(r.pass).toBe(false);
    const created = r.checks.find((c) => c.name === 'сделка создана');
    expect(created).toBeTruthy();
    expect(created.ok).toBe(false);
  });

  it('неверное имя поставщика при заданном supplier.name → fail', () => {
    const expWithName = { ...expected, supplier: { unp: '191234567', name: 'ООО Поставщик' } };
    const bad = { ...goodActual, supplier: { unp: '191234567', name: 'ООО Левый' } };
    expect(scoreResult(bad, expWithName).pass).toBe(false);
  });
});

describe('scoreResult — multi-item (позиционная сверка)', () => {
  const expected = {
    fixture: 'multi.pdf', expect: 'deal', currency: 'BYN',
    items: [
      { name: 'Цемент М500', priceExclVat: 100, quantity: 10 },
      { name: 'Песок строительный', priceExclVat: 20, quantity: 50 },
    ],
  };
  const base = { currency: 'BYN', deal: { dealId: 'd-1' } };

  it('обе позиции в верном порядке → pass', () => {
    const actual = { ...base, items: [
      { name: 'Цемент М500 (мешок)', priceExclVat: 100, quantity: 10 },
      { name: 'Песок строительный', priceExclVat: 20, quantity: 50 },
    ] };
    expect(scoreResult(actual, expected).pass).toBe(true);
  });

  it('позиции переставлены местами → fail (сверка позиционная)', () => {
    const actual = { ...base, items: [
      { name: 'Песок строительный', priceExclVat: 20, quantity: 50 },
      { name: 'Цемент М500', priceExclVat: 100, quantity: 10 },
    ] };
    expect(scoreResult(actual, expected).pass).toBe(false);
  });
});

describe('scoreResult — падение прогона (runner)', () => {
  it('eval_run_failed на deal-фикстуре → fail (ошибка прогона не маскируется)', () => {
    const expected = { fixture: 'byn-ok.pdf', expect: 'deal', currency: 'BYN' };
    const r = scoreResult({ error: 'eval_run_failed', message: 'spawn claude ENOENT' }, expected);
    expect(r.pass).toBe(false);
  });
});

describe('scoreResult — неизвестный expect', () => {
  it('expect не "error"/"deal" → pass=false + check "valid expected.expect"', () => {
    const r = scoreResult({}, { fixture: 'f.pdf', expect: 'Deal' });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'valid expected.expect')).toBeTruthy();
  });
});
