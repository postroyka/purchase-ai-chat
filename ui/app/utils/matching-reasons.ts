// Pure logic for the «Проблемы матчинга» panel (issue #182, channel «MCP»). Extracted from
// metrics.vue so the fold — and the label-key wiring against the backend's outcome/warning codes —
// is unit-testable (mirrors app/utils/result-badges.ts).

import type { MetricNamedCount, MetricsSnapshot } from '../composables/useMetrics'

// Russian labels keyed by the SAME codes computeMatchingReasons emits (and the backend records).
export const MATCHING_REASON_LABELS: Record<string, string> = {
  supplier_not_found: 'Поставщик не найден',
  contract_not_found: 'Договор не найден',
  foreign_supplier: 'Иностранный поставщик (РФ)',
  unsupported_currency: 'Валюта не BYN',
  no_items_matched: 'Позиции без каталога'
}

// УНП fields render as-is; only the overflow bucket is relabelled.
export const SUPPLIER_LABELS: Record<string, string> = { __other__: 'Прочие (сверх лимита)' }

// Fold the matching-failure codes already counted in outcomes (supplier/contract/РФ/валюта) +
// warnings (no_items_matched) into ONE ranked "where matching fails" list. Drops zero counts.
export function computeMatchingReasons(
  snapshot: Pick<MetricsSnapshot, 'outcomes' | 'warnings'> | null
): MetricNamedCount[] {
  if (!snapshot) return []
  const pick = (arr: MetricNamedCount[], name: string) => arr.find(x => x.name === name)?.count ?? 0
  return [
    { name: 'supplier_not_found', count: pick(snapshot.outcomes, 'supplier_not_found') },
    { name: 'contract_not_found', count: pick(snapshot.outcomes, 'contract_not_found') },
    { name: 'foreign_supplier', count: pick(snapshot.outcomes, 'foreign_supplier') },
    { name: 'unsupported_currency', count: pick(snapshot.outcomes, 'unsupported_currency') },
    { name: 'no_items_matched', count: pick(snapshot.warnings, 'no_items_matched') }
  ].filter(r => r.count > 0).sort((a, b) => b.count - a.count)
}
