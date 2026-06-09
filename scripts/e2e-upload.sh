#!/usr/bin/env bash
# =====================================================================
#  Сквозная проверка procure-ai: загрузка файла → опрос статуса.
#
#  В отличие от smoke-test.sh (только читает), этот скрипт СОЗДАЁТ реальное
#  задание и прогоняет весь путь: nginx → backend → агент (Claude Code/DeepSeek)
#  → MCP. По умолчанию идёт на себя через nginx-proxy (--resolve 127.0.0.1),
#  поэтому работает и за NAT.
#
#  Запуск на сервере:        cd ~/procure-ai && bash e2e-upload.sh
#  Снаружи (обычный DNS):    RESOLVE_IP="" bash e2e-upload.sh
#  Самоподписанный TLS:      INSECURE=1 bash e2e-upload.sh
#
#  Переменные: DOMAIN (по умолч. purchase.postroyka.by), RESOLVE_IP (127.0.0.1),
#              INSECURE=1, TIMEOUT (сек, по умолч. 300),
#              BACKEND_API_TOKEN (или берётся из .env.prod рядом со скриптом).
#
#  Скопируйте весь вывод и пришлите его.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"
TIMEOUT="${TIMEOUT:-300}"
BASE="https://$DOMAIN"

CURL=(curl -s --max-time 30)
[ "$INSECURE" = "1" ] && CURL+=(-k)
[ -n "$RESOLVE_IP" ] && CURL+=(--resolve "$DOMAIN:443:$RESOLVE_IP")

# Токен: из окружения или из .env.prod рядом. В вывод не печатается.
TOKEN="${BACKEND_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env.prod ]; then
  TOKEN=$(grep -E '^BACKEND_API_TOKEN=' .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]].*$//')
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-with-secure-token" ]; then
  echo "[FAIL] Нет BACKEND_API_TOKEN (в окружении или .env.prod рядом). Прерываю."
  exit 1
fi

echo "Сквозная проверка procure-ai  (домен: $DOMAIN)"
echo "Дата: $(date)"

# Минимальный валидный PDF (file-type определит по сигнатуре %PDF).
tmpf="$(mktemp --suffix=.pdf 2>/dev/null || mktemp)"
trap 'rm -f "$tmpf"' EXIT
cat > "$tmpf" <<'PDF'
%PDF-1.4
1 0 obj
<< /Type /Catalog >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
PDF

echo
echo "=== 1. Загрузка файла (POST /upload) ==="
resp=$("${CURL[@]}" -X POST "$BASE/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files[]=@$tmpf;type=application/pdf;filename=e2e-test.pdf")
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
  done)  echo "✅ Задание завершено (status=done). Детали по файлам — в JSON выше." ;;
  error) echo "⚠️  status=error — смотрите поле error по файлам в JSON выше."
         echo "    На текущем этапе это ОЖИДАЕМО: MCP-инструменты b24_pst_crm_* — заглушки." ;;
  *)     echo "⏱  Не дождались терминального статуса за ${TIMEOUT}s (последний: ${status:-нет})."
         echo "    Возможен таймаут агента или проблема с провайдером модели (DeepSeek/Anthropic)." ;;
esac
