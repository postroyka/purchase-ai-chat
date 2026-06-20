// Единый денежный формат для дашборда /metrics (по спеку заказчика):
// пробел‑разряды, точка‑десятичные, валюта строчным суффиксом — `55 123.62 usd` / `66 356.49 byn`.
// (en‑US даёт «,»‑разряды + «.»‑дробную → меняем «,» на пробел; вынесено из metrics.vue для юнит‑тестов.)
//
// Точность: 2 знака для обычных сумм; суб‑единичные ненулевые суммы (мелкая стоимость модели —
// доли цента за прогон) показываем до 4 знаков, чтобы они не схлопывались в «0.00». Глубоко
// околонулевые значения (−0 после округления) нормализуем в 0 — без «-0.00».
export function money(value: number, currency: 'usd' | 'byn'): string {
  const abs = Math.abs(value)
  const maxFrac = abs > 0 && abs < 1 ? 4 : 2
  const rounded = Math.round(value * 10 ** maxFrac) / 10 ** maxFrac || 0 // округление + squash -0
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac })
    .format(rounded)
    .replace(/,/g, ' ')
  return `${formatted} ${currency}`
}
