#!/usr/bin/env bash
# =====================================================================
#  Сквозная проверка procure-ai: загрузка РЕАЛЬНОГО файла → опрос статуса.
#  Гоняет весь путь: nginx → backend → извлечение текста → агент (DeepSeek) → MCP.
#  По умолчанию идёт на себя через nginx-proxy (--resolve 127.0.0.1) — работает за NAT.
#
#  Запуск на сервере:        cd ~/procure-ai && bash e2e-upload.sh
#  Свой файл:                FILE=/path/to/invoice.pdf bash e2e-upload.sh
#  Снаружи (обычный DNS):    RESOLVE_IP="" bash e2e-upload.sh
#  Самоподписанный TLS:      INSECURE=1 bash e2e-upload.sh
#
#  Переменные: FILE (по умолч. samples/etalon-invoice.pdf), DOMAIN, RESOLVE_IP,
#              INSECURE, TIMEOUT (сек, 300), BACKEND_API_TOKEN (или из .env.prod).
#  Скопируйте весь вывод и пришлите.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"
TIMEOUT="${TIMEOUT:-300}"
FILE="${FILE:-samples/etalon-invoice.pdf}"
BASE="https://$DOMAIN"

CURL=(curl -s --max-time 60)
[ "$INSECURE" = "1" ] && CURL+=(-k)
[ -n "$RESOLVE_IP" ] && CURL+=(--resolve "$DOMAIN:443:$RESOLVE_IP")

if [ ! -f "$FILE" ]; then
  echo "[FAIL] Не найден файл: $FILE"
  echo "       Укажи путь: FILE=/path/to/invoice.pdf bash e2e-upload.sh"
  exit 1
fi

TOKEN="${BACKEND_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env.prod ]; then
  TOKEN=$(grep -E '^BACKEND_API_TOKEN=' .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]].*$//')
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-with-secure-token" ]; then
  echo "[FAIL] Нет BACKEND_API_TOKEN (в окружении или .env.prod рядом)."
  exit 1
fi

fname="$(basename "$FILE")"
echo "Сквозная проверка procure-ai  (домен: $DOMAIN)"
echo "Дата: $(date)"
echo "Файл: $FILE ($(wc -c < "$FILE" | tr -d ' ') байт)"

echo
echo "=== 1. Загрузка файла (POST /upload) ==="
resp=$("${CURL[@]}" -X POST "$BASE/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files[]=@$FILE;filename=$fname")
echo "Ответ: $resp"
jobId=$(printf '%s' "$resp" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
if [ -z "$jobId" ]; then
  echo "[FAIL] Не получили jobId — загрузка не удалась (см. ответ выше)."
  exit 1
fi
echo "[ OK ] jobId=$jobId"

echo
echo "=== 2. Опрос статуса (GET /job/$jobId/status, до ${TIMEOUT}s) ==="
deadline=$(( $(date +%s) + TIMEOUT ))
status=""; last=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  last=$("${CURL[@]}" -H "Authorization: Bearer $TOKEN" "$BASE/job/$jobId/status")
  status=$(printf '%s' "$last" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  echo "  status=${status:-?}"
  case "$status" in done|error) break ;; esac
  sleep 3
done
echo "Финальный ответ: $last"

echo
echo "=== ИТОГ ==="
case "$status" in
  done)  echo "✅ status=done — детали по файлам в JSON выше." ;;
  error) echo "⚠️  status=error — смотри поле error по файлам в JSON выше." ;;
  *)     echo "⏱  Не дождались терминального статуса за ${TIMEOUT}s (последний: ${status:-нет})." ;;
esac
