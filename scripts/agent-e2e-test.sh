#!/usr/bin/env bash
# =====================================================================
#  Сквозной тест агента (#36 runAgent) на развёрнутом сервере.
#
#  Что делает: загружает файл через защищённый /upload, опрашивает
#  /job/:id/status до завершения, достаёт логи агента из контейнера
#  procure-app и объясняет результат человеческим языком.
#
#  ⚠️  Week 1: инструменты MCP (b24_pst_crm_*) — ЗАГЛУШКИ. Поэтому
#  «успех» здесь = агент ЗАПУСТИЛСЯ, авторизовался, прочитал файл и
#  ДОШЁЛ до вызова MCP (где упёрся в заглушку). Реальная сделка в
#  Bitrix24 появится только после реализации тел инструментов (Week 2).
#
#  Запуск на сервере (проверяет сам себя через локальный nginx-proxy):
#     cd ~/procure-ai && bash agent-e2e-test.sh
#
#  Если рядом лежит etalon-invoice.pdf (или samples/etalon-invoice.pdf),
#  скрипт по умолчанию берёт его как реальный тестовый счёт.
#
#  Со своим реальным прайс-листом:
#     FILE=/path/to/price.xlsx bash agent-e2e-test.sh
#
#  Снаружи (через обычный DNS, с любой машины):
#     RESOLVE_IP="" DOMAIN=purchase.postroyka.by \
#       BACKEND_API_TOKEN=... bash agent-e2e-test.sh
#
#  Переменные:
#     DOMAIN=...            домен (по умолчанию purchase.postroyka.by)
#     RESOLVE_IP=1.2.3.4    куда слать запросы (по умолч. 127.0.0.1;
#                           пусто = обычный DNS)
#     INSECURE=1            не проверять TLS-сертификат
#     FILE=/path/file.pdf   свой файл (иначе генерируется тестовый PDF)
#     BACKEND_API_TOKEN=... токен (иначе берётся из ./.env.prod)
#     RESPONSIBLE_ID=123    ID ответственного Б24 (иначе из .env.prod)
#     POLL_TIMEOUT=360      сколько секунд ждать завершения job
#     APP_CONTAINER=procure-app   имя контейнера бэкенда
#
#  Скрипт ничего не меняет в системе. Скопируйте весь вывод и пришлите.
# =====================================================================
set -u

DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"
POLL_TIMEOUT="${POLL_TIMEOUT:-360}"
APP_CONTAINER="${APP_CONTAINER:-procure-app}"

hdr() { echo; echo "=== $1 ==="; }
have() { command -v "$1" >/dev/null 2>&1; }

# Надёжное извлечение поля из JSON: jq → python3 → sed (последний шанс).
# $1=json  $2=jq-выражение  $3=python-выражение  $4=sed-выражение (опц.)
json_get() {
  local j="$1" v=""
  if have jq; then v=$(printf '%s' "$j" | jq -r "$2 // empty" 2>/dev/null); fi
  if [ -z "$v" ] && have python3; then
    v=$(printf '%s' "$j" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); x=$3; print('' if x is None else x)
except Exception:
    pass" 2>/dev/null)
  fi
  if [ -z "$v" ] && [ -n "${4:-}" ]; then v=$(printf '%s' "$j" | sed -n "$4" 2>/dev/null | head -1); fi
  printf '%s' "$v"
}

# --- Токен авторизации: из окружения или из .env.prod рядом со скриптом ----
TOKEN="${BACKEND_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env.prod ]; then
  TOKEN=$(grep -E '^BACKEND_API_TOKEN=' .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]].*$//')
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-with-secure-token" ]; then
  echo "✗ Нет BACKEND_API_TOKEN (укажите переменной окружения или в ./.env.prod). Прерываю."
  exit 1
fi

# --- ID ответственного (необязательно) ------------------------------------
RESPONSIBLE_ID="${RESPONSIBLE_ID:-}"
if [ -z "$RESPONSIBLE_ID" ] && [ -f .env.prod ]; then
  RESPONSIBLE_ID=$(grep -E '^PUBLIC_PAGE_RESPONSIBLE_USER_ID=' .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]].*$//')
fi

# --- Аргументы curl: --resolve (если задан IP) и -k (если INSECURE) --------
CURL=(curl -s --max-time 60)
[ "$INSECURE" = "1" ] && CURL+=(-k)
if [ -n "$RESOLVE_IP" ]; then
  CURL+=(--resolve "$DOMAIN:443:$RESOLVE_IP" --resolve "$DOMAIN:80:$RESOLVE_IP")
  mode="локально через $RESOLVE_IP (как настоящий $DOMAIN)"
else
  mode="через обычный DNS"
fi
BASE="https://$DOMAIN"

echo "Сквозной тест агента procure-ai  (домен: $DOMAIN, режим: $mode)"
echo "Дата: $(date)"

# --- Тестовый файл: свой (FILE=...) или генерируем валидный PDF ------------
TMP_PDF=""
cleanup() { [ -n "$TMP_PDF" ] && rm -f "$TMP_PDF" 2>/dev/null; }
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
# Приоритет источника файла: явный FILE → рядом лежащий эталон → генерация.
SAMPLE=""
if [ -n "${FILE:-}" ]; then
  if [ ! -f "$FILE" ]; then echo "✗ FILE='$FILE' не найден. Прерываю."; exit 1; fi
  SAMPLE="$FILE"; SAMPLE_LABEL="ваш"
else
  for cand in "./etalon-invoice.pdf" "$SCRIPT_DIR/etalon-invoice.pdf" "$SCRIPT_DIR/samples/etalon-invoice.pdf"; do
    if [ -f "$cand" ]; then SAMPLE="$cand"; SAMPLE_LABEL="эталонный счёт"; break; fi
  done
fi

if [ -n "$SAMPLE" ]; then
  UPLOAD_FILE="$SAMPLE"
  echo "Файл: $UPLOAD_FILE ($SAMPLE_LABEL)"
else
  TMP_PDF="$(mktemp /tmp/procure-test-XXXXXX.pdf)"
  # Минимальный валидный односраничный PDF с осмысленным текстом прайс-листа.
  # xref-офсеты считаются на лету python'ом, чтобы PDF был структурно корректен.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$TMP_PDF" <<'PYEOF'
import sys
text = ("BT /F1 12 Tf 72 720 Td (PROCURE-AI TEST PRICE LIST) Tj "
        "0 -24 Td (Supplier: OOO TestPostavshchik, UNP 191234567) Tj "
        "0 -24 Td (Item: Tsement M500, 10 meshkov, 25.00 BYN/sht) Tj "
        "0 -24 Td (Item: Kirpich krasnyy, 500 sht, 0.80 BYN/sht) Tj ET")
objs = []
objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
stream = text.encode("latin-1")
objs.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, body in enumerate(objs, start=1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref_pos = len(out)
out += b"xref\n0 %d\n" % (len(objs) + 1)
out += b"0000000000 65535 f \n"
for off in offsets:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objs) + 1)
out += b"startxref\n%d\n%%%%EOF\n" % xref_pos
open(sys.argv[1], "wb").write(out)
PYEOF
  else
    # Фолбэк без python3: заголовок %PDF гарантирует определение типа как
    # application/pdf. Структура упрощённая — извлечение может быть неполным,
    # но для проверки «агент запустился и дошёл до MCP» этого достаточно.
    printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$TMP_PDF"
    echo "ℹ python3 не найден — использую упрощённый тестовый PDF."
  fi
  UPLOAD_FILE="$TMP_PDF"
  echo "Файл: сгенерирован тестовый PDF ($(wc -c < "$TMP_PDF") байт)"
fi

# --- 1. Загрузка ----------------------------------------------------------
hdr "1. Загрузка файла → POST /upload"
UP_ARGS=(-X POST "$BASE/upload" -H "Authorization: Bearer $TOKEN"
         -F "files[]=@$UPLOAD_FILE")
[ -n "$RESPONSIBLE_ID" ] && UP_ARGS+=(-F "responsibleUserId=$RESPONSIBLE_ID")
RESP=$("${CURL[@]}" "${UP_ARGS[@]}" 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "✗ curl при загрузке вернул ошибку (код $rc) — сервер недоступен / таймаут / ошибка TLS."
  echo "  Проверьте DOMAIN/RESOLVE_IP/INSECURE и что контейнеры подняты."
  exit 1
fi
echo "Ответ: $RESP"

JOB_ID=$(json_get "$RESP" '.jobId' "d.get('jobId')" 's/.*"jobId":"\([^"]*\)".*/\1/p')
if [ -z "$JOB_ID" ]; then
  echo "✗ Не удалось получить jobId — загрузка не прошла. Проверьте токен/домен/контейнеры."
  exit 1
fi
echo "✓ jobId: $JOB_ID"

# --- 2. Опрос статуса -----------------------------------------------------
hdr "2. Ожидание обработки → GET /job/$JOB_ID/status"
START=$(date +%s)
STATUS_JSON=""
JOB_STATUS=""
while :; do
  # Ошибку опроса не считаем фатальной — сеть может моргнуть, продолжаем опрос.
  STATUS_JSON=$("${CURL[@]}" -H "Authorization: Bearer $TOKEN" "$BASE/job/$JOB_ID/status" 2>/dev/null) || true
  JOB_STATUS=$(json_get "$STATUS_JSON" '.status' "d.get('status')" 's/.*"status":"\([a-z]*\)".*/\1/p')
  elapsed=$(( $(date +%s) - START ))
  printf '\r  [%3ss] статус job: %-12s' "$elapsed" "${JOB_STATUS:-?}"
  case "$JOB_STATUS" in
    done|error) echo; break ;;
  esac
  if [ "$elapsed" -ge "$POLL_TIMEOUT" ]; then
    echo; echo "⚠ Таймаут ожидания ($POLL_TIMEOUT с). Агент мог ещё работать (claude бывает медленным)."
    break
  fi
  sleep 3
done

echo "Полный ответ статуса:"
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$STATUS_JSON" | jq . 2>/dev/null || printf '%s\n' "$STATUS_JSON"
else
  printf '%s\n' "$STATUS_JSON"
fi

# Достаём статус и текст ошибки первого файла (jq/python — корректно для любых символов).
FILE_STATUS=$(json_get "$STATUS_JSON" '.files[0].status' "d['files'][0].get('status')")
FILE_ERROR=$(json_get "$STATUS_JSON" '.files[0].error' "d['files'][0].get('error')")

# --- 3. Логи агента из контейнера -----------------------------------------
hdr "3. Логи агента (контейнер $APP_CONTAINER)"
if command -v docker >/dev/null 2>&1 && docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  docker logs --tail 400 "$APP_CONTAINER" 2>&1 \
    | grep -E "\[agent|\[processJob|$JOB_ID" \
    | tail -40 || echo "(строк по агенту не найдено)"
else
  echo "(docker недоступен или контейнер $APP_CONTAINER не найден — пропускаю; запустите скрипт на сервере)"
fi

# --- 4. Вердикт -----------------------------------------------------------
hdr "ВЕРДИКТ"
echo "job.status=${JOB_STATUS:-?}  file.status=${FILE_STATUS:-?}"
[ -n "$FILE_ERROR" ] && echo "file.error=$FILE_ERROR"
echo

low_err=$(printf '%s' "$FILE_ERROR" | tr '[:upper:]' '[:lower:]')
if [ "$FILE_STATUS" = "done" ]; then
  echo "✅ ПОЛНЫЙ УСПЕХ: агент отработал и вернул результат (сделка/данные)."
  echo "   Это значит, что MCP-инструменты уже отвечают (Week 2 готов?)."
elif printf '%s' "$low_err" | grep -Eq 'not found|enoent|no such file|spawn .* enoent|cli not found'; then
  echo "❌ FAIL: claude CLI не найден в контейнере (ENOENT/not found)."
  echo "   Проверьте, что в образе app установлен claude и доступен в PATH"
  echo "   (CLAUDE_CODE_BIN), и что образ свежий (после merge #45)."
elif printf '%s' "$low_err" | grep -Eq 'not logged in|/login|unauthorized.*anthropic|invalid api key|authentication'; then
  echo "❌ FAIL: агент не авторизован (Not logged in / неверный ключ)."
  echo "   На сервере нужен ANTHROPIC_API_KEY в окружении контейнера app,"
  echo "   либо проброшенная сессия. Подписочная авторизация в Docker не живёт."
elif printf '%s' "$low_err" | grep -Eq 'mcp|connect|econnrefused|fetch failed|tool .* not|getaddrinfo|socket hang up'; then
  echo "✅ УРОВЕНЬ 1 PASS: агент ЗАПУСТИЛСЯ, авторизовался, прочитал файл"
  echo "   и ДОШЁЛ до MCP — упёрся в заглушку/недоступность инструментов."
  echo "   Это ОЖИДАЕМО на Week 1. Полный флоу разблокируется в Week 2"
  echo "   (реализация тел b24_pst_crm_*). runAgent (#36) работает. 🎉"
elif [ "$JOB_STATUS" = "error" ] || [ "$FILE_STATUS" = "error" ]; then
  echo "⚠ Агент завершился ошибкой, но она не распознана автоматически."
  echo "   Посмотрите file.error и логи выше. Если там про MCP/инструменты —"
  echo "   это Уровень 1 PASS. Если про PDF/парсинг — агент работает, просто"
  echo "   тестовый файл слаб (запустите с FILE=ваш-реальный-прайс)."
else
  echo "⚠ Непонятное состояние (возможно таймаут). Пришлите весь вывод —"
  echo "   логи раздела 3 покажут, докуда дошёл агент."
fi
echo
echo "Готово. Скопируйте весь вывод и пришлите."
