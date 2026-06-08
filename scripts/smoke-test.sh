#!/usr/bin/env bash
# =====================================================================
#  Проверка развёрнутого сервера procure-ai.
#
#  По умолчанию запускается НА СЕРВЕРЕ и проверяет сам себя через
#  локальный nginx-proxy (curl --resolve ... 127.0.0.1), поэтому
#  корректно работает даже когда сервер за NAT и не видит себя по
#  публичному домену (hairpin NAT). Сертификат при этом проверяется
#  по-настоящему — по имени домена.
#
#  Запуск на сервере:
#     cd ~/procure-ai && bash smoke-test.sh
#
#  Проверка снаружи (с любой машины, через настоящий DNS):
#     RESOLVE_IP="" bash smoke-test.sh
#
#  Прочие переменные:
#     DOMAIN=...        домен (по умолчанию purchase.postroyka.by)
#     RESOLVE_IP=1.2.3.4  куда направлять запросы (по умолч. 127.0.0.1;
#                         пусто = обычный DNS)
#     INSECURE=1        не проверять TLS-сертификат (для самоподписанных)
#
#  Скрипт ничего не меняет. Скопируйте весь вывод и пришлите его.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"

pass=0; fail=0
ok()  { echo "[ OK ] $1"; pass=$((pass+1)); }
bad() { echo "[FAIL] $1"; fail=$((fail+1)); }
hdr() { echo; echo "=== $1 ==="; }

# Собираем общие аргументы curl: --resolve (если задан IP) и -k (если INSECURE).
CURL=(curl -s --max-time 15)
[ "$INSECURE" = "1" ] && CURL+=(-k)
if [ -n "$RESOLVE_IP" ]; then
  CURL+=(--resolve "$DOMAIN:443:$RESOLVE_IP" --resolve "$DOMAIN:80:$RESOLVE_IP")
  OPENSSL_CONNECT="$RESOLVE_IP:443"
  mode="локально через $RESOLVE_IP (как настоящий $DOMAIN)"
else
  OPENSSL_CONNECT="$DOMAIN:443"
  mode="через обычный DNS"
fi

echo "Проверка сервера procure-ai  (домен: $DOMAIN, режим: $mode)"
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
hdr "3. TLS-сертификат"
if command -v openssl >/dev/null 2>&1; then
  certinfo=$(echo | timeout 10 openssl s_client -servername "$DOMAIN" -connect "$OPENSSL_CONNECT" 2>/dev/null \
             | openssl x509 -noout -issuer -enddate 2>/dev/null)
  enddate=$(echo "$certinfo" | sed -n 's/^notAfter=//p')
  issuer=$(echo "$certinfo"  | sed -n 's/^issuer=//p')
  if [ -n "${enddate:-}" ]; then
    ok "Сертификат выдан (издатель:${issuer:-?}), действует до: $enddate"
  else
    bad "Сертификат не отдаётся nginx-proxy (ещё не выпущен или порт 443 не отвечает)"
  fi
else
  echo "[--] openssl не установлен — пропускаю проверку сертификата"
fi

# ---------------------------------------------------------------------
hdr "4. HTTPS через nginx-proxy (с проверкой сертификата)"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN/health" 2>/dev/null)
case "$code" in
  200) ok  "https://$DOMAIN/health → 200" ;;
  000) bad "https://$DOMAIN/health → нет соединения / ошибка TLS (запустите с INSECURE=1 для деталей)" ;;
  *)   bad "https://$DOMAIN/health → код $code" ;;
esac
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null)
case "$code" in
  200|401) ok  "https://$DOMAIN/ → $code (главная страница отвечает)" ;;
  000)     bad "https://$DOMAIN/ → нет соединения / ошибка TLS" ;;
  *)       bad "https://$DOMAIN/ → код $code" ;;
esac

# ---------------------------------------------------------------------
hdr "5. Авторизация (защита включена)"
# Запрос без токена должен получать 401.
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN/job/smoke-test/status" 2>/dev/null)
if [ "$code" = "401" ]; then
  ok "GET /job/.../status без токена → 401 (защита работает)"
else
  bad "GET /job/.../status без токена → $code (ожидался 401)"
fi
# MCP не публикуется наружу — проверяем изнутри, что /mcp требует токен.
mcpcode=$(docker exec procure-mcp wget -S -qO- http://localhost:3000/mcp 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | grep -oE '[0-9]+$' | head -1)
if [ "${mcpcode:-}" = "401" ]; then
  ok "mcp /mcp без токена → 401 (защита работает)"
else
  echo "[--] mcp /mcp вернул код ${mcpcode:-нет ответа} (информативно, не критично)"
fi

# ---------------------------------------------------------------------
hdr "ИТОГ"
echo "Успешно: $pass    Ошибок: $fail"
if [ "$fail" -eq 0 ]; then
  echo "✅ Сервер готов и отвечает."
else
  echo "⚠️  Есть проблемы — смотрите строки [FAIL] выше и пришлите весь вывод."
fi
