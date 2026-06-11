#!/usr/bin/env bash
# =====================================================================
#  Проверка дашборда метрик procure-ai: GET /metrics/data → сводка.
#  Гоняет защищённый эндпоинт метрик и печатает ключевые показатели + экономику.
#
#  Запуск на сервере:        cd ~/procure-ai && bash check-metrics.sh
#  Локально:                 BASE=http://localhost:3000 BACKEND_API_TOKEN=dev-token-local bash check-metrics.sh
#  Снаружи (обычный DNS):    RESOLVE_IP="" bash check-metrics.sh
#  Самоподписанный TLS:      INSECURE=1 bash check-metrics.sh
#
#  Переменные: BASE (иначе https://$DOMAIN), DOMAIN, RESOLVE_IP, INSECURE,
#              BACKEND_API_TOKEN (или берётся из .env.prod рядом).
#  Скопируйте весь вывод и пришлите.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"
BASE="${BASE:-https://$DOMAIN}"

CB=(curl -s --max-time 30)
[ "$INSECURE" = "1" ] && CB+=(-k)
# --resolve нужен только для формы https://DOMAIN (заход на себя через nginx-proxy за NAT)
[ "$BASE" = "https://$DOMAIN" ] && [ -n "$RESOLVE_IP" ] && CB+=(--resolve "$DOMAIN:443:$RESOLVE_IP")

TOKEN="${BACKEND_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env.prod ]; then
  TOKEN=$(grep -E '^BACKEND_API_TOKEN=' .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]].*$//')
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-with-secure-token" ]; then
  echo "[FAIL] Нет BACKEND_API_TOKEN (в окружении или .env.prod рядом)."
  exit 1
fi

URL="$BASE/metrics/data"
echo "Метрики procure-ai  →  $URL"
echo "Дата: $(date)"
echo "---------------------------------------------"

BODY=$("${CB[@]}" -H "Authorization: Bearer $TOKEN" -w $'\n%{http_code}' "$URL")
CODE=$(printf '%s' "$BODY" | tail -n1)
JSON=$(printf '%s' "$BODY" | sed '$d')

if [ "$CODE" != "200" ]; then
  echo "[FAIL] HTTP $CODE"
  printf '%s\n' "$JSON"
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  JSON="$JSON" python3 - <<'PY'
import os, json
d = json.loads(os.environ["JSON"])
t = d.get("totals", {}); e = d.get("economics", {})
j = lambda arr, n=99: ", ".join("%s=%s" % (o["name"], o["count"]) for o in arr[:n]) or "—"
print("Загрузок:            ", t.get("uploads"))
print("Файлов:              ", t.get("files"), "(done %s / error %s)" % (t.get("filesDone"), t.get("filesError")))
print("Успешных сделок:     ", t.get("ok"), "(%s%%)" % t.get("successRatePct"))
print("Стоимость, всего:     $%s  (прогонов с ценой: %s)" % (t.get("costUsd"), t.get("costRuns")))
print("Сред. время агента:  ", t.get("avgAgentMs"), "мс")
print()
print("Топ исходов:         ", j(d.get("outcomes", []), 5))
print("Форматы:             ", j(d.get("formats", [])))
print("Извлечение:          ", j(d.get("extract", [])))
if e.get("enabled"):
    print()
    print("ЭКОНОМИКА (оценка; ставка %s BYN/ч, %s мин/поз):" % (e.get("hourlyRateByn"), e.get("minutesPerPosition")))
    print("  Сэкономлено (нетто):        %s BYN" % e.get("netSavedByn"))
    print("  Потеря на пустых артикулах: %s BYN (%s%% позиций без артикула)" % (e.get("lostNoArticleByn"), e.get("positionsNoArticlePct")))
    print("  Позиций:                    %s (без артикула: %s)" % (e.get("positions"), e.get("positionsNoArticle")))
else:
    print()
    print("ЭКОНОМИКА: выключена (HOURLY_RATE_BYN=0)")
PY
  echo "---------------------------------------------"
  echo "[OK] /metrics/data доступен (HTTP 200)."
else
  printf '%s\n' "$JSON"
  echo "---------------------------------------------"
  echo "[OK] HTTP 200 (python3 не найден — показан сырой JSON)."
fi
