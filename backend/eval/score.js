// Чистый скоринг eval-прогона агента: сравнивает результат агента с эталонным
// спеком и даёт повердиктный разбор по полям. Без I/O и без модели — поэтому
// покрыт юнит-тестами (backend/tests/eval-score.test.js), в отличие от runner'а,
// который требует живого агента.
//
// Отдельно — проверка НАПРАВЛЕНИЯ НДС: классическая ошибка из #58 — посчитать
// цену без НДС как `цена_с_НДС × 0.8` вместо `÷ 1.2` (расхождение 4%). Если в
// эталоне задан `priceInclVatHint`, скорер ловит именно это.

const EPSILON = 0.01; // допуск округления для денег (BYN, 2 знака)

const round2 = (n) => Math.round(n * 100) / 100;

/** Нормализация имени для нестрогого сравнения (регистр/пробелы/кавычки). */
export function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/["'«».,]/g, '')
    .replace(/[-–—]/g, ' ') // дефис/тире → пробел: «Wellton-45» ≈ «Wellton 45»
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Проверка направления НДС по одной позиции.
 * Дан включающий НДС удельный прайс из документа (hint) и `priceExclVat` агента —
 * убеждаемся, что агент поделил на 1.2 (верно), а не умножил на 0.8 (баг #58).
 * @returns {{ok:boolean, correct:number, wrong:number, got:number, gotCloserTo:string}|null}
 */
export function checkVatDirection(priceExclVat, priceInclVatHint) {
  if (priceInclVatHint == null || priceExclVat == null) return null;
  const correct = priceInclVatHint / 1.2;
  const wrong = priceInclVatHint * 0.8;
  const dCorrect = Math.abs(priceExclVat - correct);
  const dWrong = Math.abs(priceExclVat - wrong);
  return {
    ok: dCorrect <= dWrong,
    correct: round2(correct),
    wrong: round2(wrong),
    got: priceExclVat,
    gotCloserTo: dCorrect <= dWrong ? 'divide_by_1.2' : 'multiply_by_0.8',
  };
}

/**
 * Скоринг одного результата агента против эталонного спека.
 * `expected.expect`: "error" (ожидаем отказ) | "deal" (ожидаем сделку).
 * @returns {{fixture:string|null, pass:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}}
 */
export function scoreResult(actual, expected) {
  const checks = [];
  const add = (name, ok, detail = 'ok') => checks.push({ name, ok: !!ok, detail });

  if (expected.expect === 'error') {
    const gotError = actual?.error ?? null;
    add(`error == ${expected.error}`, gotError === expected.error,
      `ожидали "${expected.error}", получили "${gotError ?? '(нет)'}"`);
    // На ошибочной фикстуре сделка НЕ должна быть создана.
    const dealId = actual?.deal?.dealId ?? null;
    add('сделка не создана', dealId == null,
      dealId == null ? 'ok' : `создан dealId=${dealId} — не должен`);
  } else if (expected.expect === 'deal') {
    add('нет error', actual?.error == null,
      actual?.error == null ? 'ok' : `неожиданный error="${actual.error}"`);

    // Сделка ДОЛЖНА быть создана — иначе агент лишь распознал документ, но не довёл до
    // B24 (тихий сбой create_deal). Без этой проверки такой прогон был бы ложно-зелёным.
    add('сделка создана', actual?.deal?.dealId != null,
      actual?.deal?.dealId != null ? `dealId=${actual.deal.dealId}` : 'нет deal.dealId — сделка не создана');

    if (expected.currency != null) {
      add(`currency == ${expected.currency}`, actual?.currency === expected.currency,
        `ожидали ${expected.currency}, получили ${actual?.currency ?? '(нет)'}`);
    }
    if (expected.supplier?.unp != null) {
      add('supplier.unp', String(actual?.supplier?.unp ?? '') === String(expected.supplier.unp),
        `ожидали УНП ${expected.supplier.unp}, получили ${actual?.supplier?.unp ?? '(нет)'}`);
    }
    if (expected.supplier?.name != null) {
      const en = normName(expected.supplier.name);
      const gn = normName(actual?.supplier?.name);
      add('supplier.name', !!(en && gn && (gn.includes(en) || en.includes(gn))),
        `ожидали ~"${expected.supplier.name}", получили "${actual?.supplier?.name ?? '(нет)'}"`);
    }

    const actualItems = Array.isArray(actual?.items) ? actual.items : [];
    if (Array.isArray(expected.items)) {
      add('кол-во позиций', actualItems.length === expected.items.length,
        `ожидали ${expected.items.length}, получили ${actualItems.length}`);
      // Позиции сверяем позиционно (фикстуры перечисляют их в порядке документа).
      expected.items.forEach((exp, i) => {
        const got = actualItems[i];
        const label = exp.name ?? `#${i + 1}`;
        if (!got) { add(`«${label}»`, false, 'позиция отсутствует в выводе'); return; }

        if (exp.name != null) {
          const nm = normName(exp.name);
          const an = normName(got.name);
          add(`«${label}» имя`, nm && an && (an.includes(nm) || nm.includes(an)),
            `ожидали ~"${exp.name}", получили "${got.name ?? '(нет)'}"`);
        }
        if (exp.priceExclVat != null) {
          add(`«${label}» priceExclVat`,
            got.priceExclVat != null && Math.abs(got.priceExclVat - exp.priceExclVat) <= EPSILON,
            `ожидали ${exp.priceExclVat}, получили ${got.priceExclVat ?? '(нет)'}`);
        }
        if (exp.quantity != null) {
          add(`«${label}» quantity`, got.quantity === exp.quantity,
            `ожидали ${exp.quantity}, получили ${got.quantity ?? '(нет)'}`);
        }
        const vat = checkVatDirection(got.priceExclVat, exp.priceInclVatHint);
        if (vat) {
          add(`«${label}» направление НДС`, vat.ok,
            vat.ok
              ? `ok (÷1.2 ≈ ${vat.correct})`
              : `похоже на ×0.8 (=${vat.wrong}) вместо ÷1.2 (=${vat.correct}); получили ${vat.got}`);
        }
      });
    }
  } else {
    add('valid expected.expect', false, `неизвестный expect="${expected.expect}"`);
  }

  return {
    fixture: expected.fixture ?? null,
    pass: checks.every((c) => c.ok),
    checks,
  };
}
