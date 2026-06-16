#!/usr/bin/env bash
#
# Smoke-тест PHP REST-контроллеров procure-ai на живой коробке Bitrix24.
#
# Использование (вариант 1 — заполнить scripts/.env.deploy один раз):
#   cp scripts/.env.deploy.example scripts/.env.deploy   # затем заполнить
#   bash scripts/smoke-test-b24.sh
#
# Использование (вариант 2 — через env прямо в команде):
#   WEBHOOK_URL=https://your-b24/rest/1/TOKEN/ SUPPLIER_UNP=100059180 \
#     SUPPLIER_ID=42 VENDOR_CODE=ART-12345 bash scripts/smoke-test-b24.sh
#
# Для ПОЛНОГО покрытия задайте все фикстуры: WEBHOOK_URL, SUPPLIER_UNP, SUPPLIER_ID,
# VENDOR_CODE, RESPONSIBLE_USER_ID, а также CONTRACT_NUMBER + CONTRACT_DATE — иначе
# кейсы 2b–2d (фильтр договора по номеру/дате) молча пропускаются.
#
set -euo pipefail

# Подхватываем scripts/.env.deploy, если он есть (там WEBHOOK_URL, SUPPLIER_*,
# VENDOR_CODE и т.д.) — чтобы не набирать длинную команду с env каждый раз.
# Значения из файла применяются как есть; для разового переопределения
# отредактируйте файл (он gitignored).
_ENV_FILE="$(dirname "$0")/.env.deploy"
if [ -f "$_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$_ENV_FILE"; set +a
fi

# Принимаем и WEBHOOK_URL, и PAI_WEBHOOK_URL (procure-ai namespace) как алиас.
WEBHOOK_URL="${WEBHOOK_URL:-${PAI_WEBHOOK_URL:-}}"
B24="${WEBHOOK_URL:?Задайте WEBHOOK_URL или PAI_WEBHOOK_URL (в scripts/.env.deploy или env): https://your-portal/rest/1/TOKEN/}"
B24="${B24%/}"

# --- Параметры под вашу коробку (дефолты, если не заданы в env/.env.deploy) ---
SUPPLIER_ID="${SUPPLIER_ID:-42}"
VENDOR_CODE="${VENDOR_CODE:-ART-12345}"
RESPONSIBLE_USER_ID="${RESPONSIBLE_USER_ID:-1}"
# Реальные номер и дата договора, который существует у SUPPLIER_ID
# (например из вывода 2a). Нужны для проверки фильтра по номеру/дате (кейсы 2b–2d).
# Если пусто — кейсы 2b–2d пропускаются.
CONTRACT_NUMBER="${CONTRACT_NUMBER:-}"
CONTRACT_DATE="${CONTRACT_DATE:-}"
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
  # ensure_ascii=False — чтобы кириллица из Bitrix печаталась как текст,
  # а не \uXXXX (json.tool по умолчанию это экранирует).
  echo "${payload}" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))' 2>/dev/null || echo "${payload}"
  echo ""
}

# Файл для прикрепления к тестовым сделкам (B6-поле UF_CRM_DEAL_SH_PRCHS_AI_FILE):
# берём реальный эталонный счёт из репозитория, чтобы smoke проверял загрузку
# настоящего PDF. Если файла нет — откат на минимальный валидный PDF, чтобы
# скрипт оставался самодостаточным.
ETALON_PDF="$(dirname "$0")/samples/etalon-invoice.pdf"
if [ -f "$ETALON_PDF" ]; then
  # base64 из stdin без флагов — кроссплатформенно (GNU и BSD/macOS: у macOS нет
  # -w0 и файла позиционным аргументом). tr убирает переносы строк → одна строка.
  FILE_B64=$(base64 < "$ETALON_PDF" | tr -d '\n')
else
  FILE_B64=$(printf '%s' '%PDF-1.4 1 0 obj<</Type/Catalog>>endobj' | base64 | tr -d '\n')
fi

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
# Контроллер фильтрует по номеру И дате как ТОЧНОЕ совпадение (логическое И):
# верны оба → договор найден; ошибка хотя бы в одном → result.id=null.
WRONG_NUMBER="НЕТ-ТАКОГО-НОМЕРА-XYZ"
WRONG_DATE="01.01.1990"

echo_sep "2a. find contract — только supplierId (минимальный id договора поставщика)"
b24 "shef:purchase.api.procurecontract.find" "{\"supplierId\":${SUPPLIER_ID}}"

if [ -n "${CONTRACT_NUMBER}" ] && [ -n "${CONTRACT_DATE}" ]; then
  echo_sep "2b. number + date ОБА верные (ожидаем найденный договор, id != null)"
  b24 "shef:purchase.api.procurecontract.find" \
    "{\"supplierId\":${SUPPLIER_ID},\"number\":\"${CONTRACT_NUMBER}\",\"date\":\"${CONTRACT_DATE}\"}"

  echo_sep "2c. number верный, date НЕВЕРНАЯ (ожидаем result.id=null)"
  b24 "shef:purchase.api.procurecontract.find" \
    "{\"supplierId\":${SUPPLIER_ID},\"number\":\"${CONTRACT_NUMBER}\",\"date\":\"${WRONG_DATE}\"}"

  echo_sep "2d. number НЕВЕРНЫЙ, date верная (ожидаем result.id=null)"
  b24 "shef:purchase.api.procurecontract.find" \
    "{\"supplierId\":${SUPPLIER_ID},\"number\":\"${WRONG_NUMBER}\",\"date\":\"${CONTRACT_DATE}\"}"
else
  echo_sep "2b–2d. ПРОПУЩЕНЫ — задайте CONTRACT_NUMBER и CONTRACT_DATE в scripts/.env.deploy"
fi

echo_sep "2e. find contract — несуществующий поставщик (ожидаем result.id=null)"
b24 "shef:purchase.api.procurecontract.find" '{"supplierId":999999}'

echo_sep "2f. find contract — supplierId=0 (ожидаем error con:010)"
b24 "shef:purchase.api.procurecontract.find" '{"supplierId":0}' || echo "(ожидается ошибка)"

echo_sep "2g. find contract — слишком длинный номер (ожидаем error con:011)"
b24 "shef:purchase.api.procurecontract.find" \
  "{\"supplierId\":${SUPPLIER_ID},\"number\":\"$(python3 -c "print('A'*65)")\"}" || echo "(ожидается ошибка)"

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
# Реальный id договора поставщика для осмысленной привязки в 4b: берём из
# procurecontract.find по SUPPLIER_ID (тот же договор, что отдаёт кейс 2a).
# Если договор не найден — fallback на 1, чтобы тест всё равно отработал.
REAL_CONTRACT_ID=$(curl -s -m 25 -X POST "${B24}/shef:purchase.api.procurecontract.find" \
  -H "Content-Type: application/json" -d "{\"supplierId\":${SUPPLIER_ID}}" \
  | python3 -c 'import sys, json
try:
    _v = json.load(sys.stdin).get("result", {}).get("id")
except Exception:
    _v = None
print(_v if _v else 1)')

echo_sep "4a. create deal — минимальный корректный запрос"
BODY=$(python3 -c "
import json
print(json.dumps({
  'supplierId': ${SUPPLIER_ID},
  'responsibleUserId': ${RESPONSIBLE_USER_ID},
  'fileName': 'smoke-test-invoice.pdf',
  'fileContent': '${FILE_B64}',
  'processingLog': 'Smoke-test 4a — автоматический тест',
  'items': [{'name': 'Болт М8', 'priceExclVat': 1.5, 'quantity': 100}]
}))")
b24 "shef:purchase.api.procuredeal.create" "${BODY}"

echo_sep "4b. create deal — реальный contractId (из find) + documentDate (BEGINDATE = 15.03.2025)"
BODY=$(python3 -c "
import json
print(json.dumps({
  'supplierId': ${SUPPLIER_ID},
  'responsibleUserId': ${RESPONSIBLE_USER_ID},
  'contractId': ${REAL_CONTRACT_ID},
  'documentDate': '15.03.2025',
  'fileName': 'smoke-test-invoice.pdf',
  'fileContent': '${FILE_B64}',
  'processingLog': 'Smoke-test 4b — с contractId и documentDate',
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

echo_sep "4d. create deal — пустой items[] (ожидаем сделку + warning no_items_matched, #150)"
b24 "shef:purchase.api.procuredeal.create" \
  "{\"supplierId\":${SUPPLIER_ID},\"responsibleUserId\":${RESPONSIBLE_USER_ID},\"fileName\":\"x.pdf\",\"fileContent\":\"dGVzdA==\",\"processingLog\":\"\",\"items\":[]}"

echo ""
echo "✅ Smoke-тест завершён."
echo "⚠️  Проверьте CRM Bitrix24 — удалите тестовые сделки из тестов 4a, 4b и 4d вручную."
