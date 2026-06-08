#!/usr/bin/env bash
# =====================================================================
#  Проверка развёрнутого сервера procure-ai. Запускать НА СЕРВЕРЕ (Ubuntu).
#
#  Запуск:
#     cd ~/procure-ai
#     bash smoke-test.sh
#
#  При необходимости можно задать домен:
#     DOMAIN=purchase.postroyka.by bash smoke-test.sh
#
#  Скрипт ничего не меняет — только читает состояние и печатает отчёт.
#  Скопируйте весь вывод и пришлите его.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"

pass=0; fail=0
ok()  { echo "[ OK ] $1"; pass=$((pass+1)); }
bad() { echo "[FAIL] $1"; fail=$((fail+1)); }
hdr() { echo; echo "=== $1 ==="; }

echo "Проверка сервера procure-ai  (домен: $DOMAIN)"
echo "Дата: $(date)"

# ---------------------------------------------------------------------
hdr "1. Docker-контейнеры (должны быть running)"
for c in procure-app procure-mcp procure-redis procure-watchtower nginx-proxy acme-companion; do
  status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "не найден")
  if [ "$status" = "running" ]; then ok "$c — running"; else bad "$c — $status"; fi
done

# ---------------------------------------------------------------------
hdr "2. Внутренние health-проверки"
if docker exec procure-app wget -qO- http://localhost:3000/health 2>/dev/null | grep -q '"ok":true'; then
  ok "app /health → ok (бэкенд + Redis на связи)"
else
  bad "app /health не отвечает ok"
fi

if docker exec procure-mcp wget -qO- http://localhost:3000/api/health >/dev/null 2>&1; then
  ok "mcp /api/health → отвечает"
else
  bad "mcp /api/health не отвечает"
fi

if docker exec procure-redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping' 2>/dev/null | grep -q PONG; then
  ok "redis ping → PONG"
else
  bad "redis не отвечает на ping (проверьте REDIS_PASSWORD в .env.prod)"
fi

# ---------------------------------------------------------------------
hdr "3. TLS-сертификат Let's Encrypt"
if command -v openssl >/dev/null 2>&1; then
  enddate=$(echo | timeout 10 openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "${enddate:-}" ]; then
    ok "Сертификат выдан, действует до: $enddate"
  else
    bad "Сертификат ещё не получен (acme-companion не завершил выпуск)"
  fi
else
  echo "[--] openssl не установлен — пропускаю проверку сертификата"
fi

# ---------------------------------------------------------------------
hdr "4. Публичный доступ по HTTPS"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/health" 2>/dev/null)
case "$code" in
  200)  ok  "https://$DOMAIN/health → 200" ;;
  000)  bad "https://$DOMAIN/health → нет соединения (нет сертификата или закрыт порт 443)" ;;
  *)    bad "https://$DOMAIN/health → код $code" ;;
esac

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" 2>/dev/null)
case "$code" in
  200|401) ok  "https://$DOMAIN/ → $code (главная страница отвечает)" ;;
  000)     bad "https://$DOMAIN/ → нет соединения" ;;
  *)       bad "https://$DOMAIN/ → код $code" ;;
esac

# ---------------------------------------------------------------------
hdr "ИТОГ"
echo "Успешно: $pass    Ошибок: $fail"
if [ "$fail" -eq 0 ]; then
  echo "✅ Сервер готов и отвечает."
else
  echo "⚠️  Есть проблемы — смотрите строки [FAIL] выше и пришлите весь вывод."
fi
