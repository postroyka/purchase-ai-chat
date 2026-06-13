#!/usr/bin/env bash
#
# Smoke-тест PHP REST-контроллеров procure-ai на живой коробке Bitrix24.
#
# Использование:
#   WEBHOOK_URL=https://your-b24.domain/rest/1/TOKEN/ bash scripts/smoke-test-b24.sh
#
# Для настройки конкретных ID отредактируйте переменные SUPPLIER_ID / VENDOR_CODE ниже
# или передайте их как env: SUPPLIER_ID=42 WEBHOOK_URL=... bash smoke-test-b24.sh
#
set -euo pipefail

B24="${WEBHOOK_URL:?Задайте WEBHOOK_URL=https://your-portal/rest/1/TOKEN/}"
B24="${B24%/}"

# --- Параметры под вашу коробку ---
SUPPLIER_ID="${SUPPLIER_ID:-42}"
VENDOR_CODE="${VENDOR_CODE:-ART-12345}"
RESPONSIBLE_USER_ID="${RESPONSIBLE_USER_ID:-1}"
# ----------------------------------

echo_sep() { echo ""; echo "===== $1 ====="; }

b24() {
  local method="$1" body="$2" resp http payload
  # Без -f: Bitrix отдаёт ошибки валидации как HTTP 4xx с JSON-телом
  # ({"error":"sup:011",...}); -f это тело выбросил бы, и негативные кейсы
  # ничего не показывали бы. -w добавляет HTTP-код последней строкой.
  resp=$(curl -s -w $'\n%{http_code}' -X POST "${B24}/${method}" \
    -H "Content-Type: application/json" \
    -d "${body}")
  http="${resp##*$'\n'}"      # последняя строка — код
  payload="${resp%$'\n'*}"    # всё до неё — тело
  echo "HTTP ${http}"
  echo "${payload}" | python3 -m json.tool 2>/dev/null || echo "${payload}"
  echo ""
}

FAKE_B64=$(printf '%s' '%PDF-1.4 1 0 obj<</Type/Catalog>>endobj' | base64 -w0 2>/dev/null || printf '%s' '%PDF-1.4 test' | base64)

# ── 1. procuresupplier.findbyunp ──────────────────────────────────────────────
echo_sep "1a. findByUnp — реальный УНП (задайте SUPPLIER_UNP или отредактируйте)"
UNP="${SUPPLIER_UNP:-100059180}"
b24 "shef:purchase.api.procuresupplier.findbyunp" "{\"unp\":\"${UNP}\"}"

echo_sep "1b. findByUnp — несуществующий УНП (ожидаем result.id=null)"
b24 "shef:purchase.api.procuresupplier.findbyunp" '{"unp":"000000001"}'

echo_sep "1c. findByUnp — пустой УНП (ожидаем error)"
b24 "shef:purchase.api.procuresupplier.findbyunp" '{"unp":""}' || echo "(ожидается ошибка)"

echo_sep "1d. findByUnp — слишком длинный УНП (ожидаем error sup:011)"
b24 "shef:purchase.api.procuresupplier.findbyunp" '{"unp":"000000000000000000000000000000000000"}' || echo "(ожидается ошибка)"

# ── 2. procurecontract.find ───────────────────────────────────────────────────
echo_sep "2a. find contract — только supplierId"
b24 "shef:purchase.api.procurecontract.find" "{\"supplierId\":${SUPPLIER_ID}}"

echo_sep "2b. find contract — с number и date"
b24 "shef:purchase.api.procurecontract.find" \
  "{\"supplierId\":${SUPPLIER_ID},\"number\":\"ДОГ-2024/001\",\"date\":\"01.01.2024\"}"

echo_sep "2c. find contract — несуществующий поставщик (ожидаем result.id=null)"
b24 "shef:purchase.api.procurecontract.find" '{"supplierId":999999}'

echo_sep "2d. find contract — supplierId=0 (ожидаем error con:010)"
b24 "shef:purchase.api.procurecontract.find" '{"supplierId":0}' || echo "(ожидается ошибка)"

# ── 3. procureproduct.findbyvendorcode ────────────────────────────────────────
echo_sep "3a. findByVendorCode — реальный артикул"
b24 "shef:purchase.api.procureproduct.findbyvendorcode" "{\"vendorCode\":\"${VENDOR_CODE}\"}"

echo_sep "3b. findByVendorCode — несуществующий артикул (ожидаем result.id=null)"
b24 "shef:purchase.api.procureproduct.findbyvendorcode" '{"vendorCode":"NONEXISTENT-ZZZZZ-99999"}'

echo_sep "3c. findByVendorCode — пустой артикул (ожидаем error prd:010)"
b24 "shef:purchase.api.procureproduct.findbyvendorcode" '{"vendorCode":""}' || echo "(ожидается ошибка)"

echo_sep "3d. findByVendorCode — слишком длинный артикул (ожидаем error prd:011)"
b24 "shef:purchase.api.procureproduct.findbyvendorcode" \
  '{"vendorCode":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  || echo "(ожидается ошибка)"

# ── 4. procuredeal.create ─────────────────────────────────────────────────────
echo_sep "4a. create deal — минимальный корректный запрос"
BODY=$(python3 -c "
import json
print(json.dumps({
  'supplierId': ${SUPPLIER_ID},
  'responsibleUserId': ${RESPONSIBLE_USER_ID},
  'fileName': 'smoke-test-invoice.pdf',
  'fileContent': '${FAKE_B64}',
  'processingLog': 'Smoke-test 4a — автоматический тест',
  'items': [{'name': 'Болт М8', 'priceExclVat': 1.5, 'quantity': 100}]
}))")
b24 "shef:purchase.api.procuredeal.create" "${BODY}"

echo_sep "4b. create deal — с contractId"
BODY=$(python3 -c "
import json
print(json.dumps({
  'supplierId': ${SUPPLIER_ID},
  'responsibleUserId': ${RESPONSIBLE_USER_ID},
  'contractId': 1,
  'fileName': 'smoke-test-invoice.pdf',
  'fileContent': '${FAKE_B64}',
  'processingLog': 'Smoke-test 4b — с contractId',
  'items': [
    {'vendorCode': '${VENDOR_CODE}', 'name': 'Болт М8', 'priceExclVat': 1.5, 'quantity': 10},
    {'name': 'Гайка М8 (без артикула)', 'priceExclVat': 0.5, 'quantity': 50}
  ]
}))")
b24 "shef:purchase.api.procuredeal.create" "${BODY}"

echo_sep "4c. create deal — supplierId=0 (ожидаем error deal:010)"
b24 "shef:purchase.api.procuredeal.create" \
  '{"supplierId":0,"responsibleUserId":1,"fileName":"x.pdf","fileContent":"dGVzdA==","processingLog":"","items":[{"name":"x","priceExclVat":1,"quantity":1}]}' \
  || echo "(ожидается ошибка)"

echo_sep "4d. create deal — пустой items[] (ожидаем error deal:020)"
b24 "shef:purchase.api.procuredeal.create" \
  "{\"supplierId\":${SUPPLIER_ID},\"responsibleUserId\":${RESPONSIBLE_USER_ID},\"fileName\":\"x.pdf\",\"fileContent\":\"dGVzdA==\",\"processingLog\":\"\",\"items\":[]}" \
  || echo "(ожидается ошибка)"

echo ""
echo "✅ Smoke-тест завершён."
echo "⚠️  Проверьте CRM Bitrix24 — удалите тестовые сделки из тестов 4a и 4b вручную."
