#!/usr/bin/env bash
# =====================================================================
#  Проверка РЕЗУЛЬТАТОВ задачи (ревью + правки PR #48):
#    1) /health отвечает;
#    2) публичная страница закрыта HTTP Basic (401 + запрос логина), но
#       открывается с верным логином и отклоняет неверный пароль;
#    3) API (/job/:id/status) принимает И Bearer-токен, И Basic-логин
#       (dual-auth) — браузеру не нужен токен в коде;
#    4) контейнер procure-app видит провайдера модели (DeepSeek/Anthropic).
#
#  Запуск НА СЕРВЕРЕ (читает .env.prod рядом со скриптом):
#     cd ~/procure-ai && bash verify-task.sh
#  Снаружи, через обычный DNS:
#     RESOLVE_IP="" bash verify-task.sh
#  Переменные: DOMAIN (по умолч. purchase.postroyka.by),
#              RESOLVE_IP (по умолч. 127.0.0.1; пусто = обычный DNS),
#              INSECURE=1 (не проверять TLS-сертификат).
#
#  Скрипт ничего не меняет. Скопируйте ВЕСЬ вывод и пришлите.
# =====================================================================
set -u
DOMAIN="${DOMAIN:-purchase.postroyka.by}"
RESOLVE_IP="${RESOLVE_IP-127.0.0.1}"
INSECURE="${INSECURE:-0}"

# Достаём значения из .env.prod рядом со скриптом (секреты в вывод не печатаем).
getenv() { [ -f .env.prod ] && grep -E "^$1=" .env.prod | head -1 | cut -d= -f2- | tr -d "\"'" | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }
BUSER="${PUBLIC_PAGE_BASIC_AUTH_USER:-$(getenv PUBLIC_PAGE_BASIC_AUTH_USER)}"; BUSER="${BUSER:-procure}"
BPASS="${PUBLIC_PAGE_BASIC_AUTH_PASS:-$(getenv PUBLIC_PAGE_BASIC_AUTH_PASS)}"
TOKEN="${BACKEND_API_TOKEN:-$(getenv BACKEND_API_TOKEN)}"

pass=0; fail=0; skip=0
ok()  { echo "[ OK ] $1"; pass=$((pass+1)); }
bad() { echo "[FAIL] $1"; fail=$((fail+1)); }
skp() { echo "[ -- ] $1"; skip=$((skip+1)); }

CURL=(curl -s --max-time 15)
[ "$INSECURE" = "1" ] && CURL+=(-k)
[ -n "$RESOLVE_IP" ] && CURL+=(--resolve "$DOMAIN:443:$RESOLVE_IP")
B="https://$DOMAIN"
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }

echo "Проверка результатов задачи (auth + провайдер).  Домен: $DOMAIN"
echo "Дата: $(date)"

echo; echo "=== 1. Health ==="
[ "$(code "$B/health")" = "200" ] && ok "/health → 200" || bad "/health не отвечает 200"

echo; echo "=== 2. Basic-auth публичной страницы ==="
hdrs=$("${CURL[@]}" -o /dev/null -D - -w 'CODE:%{http_code}' "$B/" 2>/dev/null)
c=$(printf '%s' "$hdrs" | grep -o 'CODE:[0-9]*' | cut -d: -f2)
if [ "$c" = "401" ] && printf '%s' "$hdrs" | grep -qi 'WWW-Authenticate: *Basic'; then
  ok "GET / без логина → 401 + WWW-Authenticate: Basic (страница закрыта паролем)"
elif [ "$c" = "401" ]; then
  bad "GET / → 401, но нет заголовка WWW-Authenticate: Basic"
else
  bad "GET / без логина → $c (ожидался 401 — basic-auth не включён? проверьте PUBLIC_PAGE_*)"
fi
if [ -n "${BPASS:-}" ] && [ "$BPASS" != "replace-with-secure-password" ]; then
  [ "$(code -u "$BUSER:$BPASS" "$B/")" = "200" ] && ok "GET / с верным логином → 200" || bad "GET / с верным логином → не 200"
  wc=$(code -u "$BUSER:nope-$RANDOM" "$B/")
  [ "$wc" = "401" ] && ok "GET / с неверным паролем → 401" || bad "GET / с неверным паролем → $wc (ожидался 401)"
else
  skp "проверка логина пропущена: PUBLIC_PAGE_BASIC_AUTH_PASS не задан в .env.prod"
fi

echo; echo "=== 3. Dual-auth на API (/job/:id/status) ==="
[ "$(code "$B/job/verify-x/status")" = "401" ] && ok "без авторизации → 401" || bad "без авторизации → не 401"
if [ -n "${BPASS:-}" ] && [ "$BPASS" != "replace-with-secure-password" ]; then
  bc=$(code -u "$BUSER:$BPASS" "$B/job/verify-x/status")
  [ "$bc" = "404" ] && ok "с Basic-логином → 404 (Basic принимается на API → токен в браузере не нужен)" || bad "с Basic → $bc (ожидался 404)"
fi
if [ -n "${TOKEN:-}" ] && [ "$TOKEN" != "replace-with-secure-token" ]; then
  tc=$(code -H "Authorization: Bearer $TOKEN" "$B/job/verify-x/status")
  [ "$tc" = "404" ] && ok "с Bearer-токеном → 404 (токен по-прежнему работает)" || bad "с Bearer → $tc (ожидался 404)"
else
  skp "Bearer-проверка пропущена: BACKEND_API_TOKEN не задан"
fi

echo; echo "=== 4. Провайдер модели в контейнере procure-app ==="
if command -v docker >/dev/null 2>&1 && docker inspect procure-app >/dev/null 2>&1; then
  base=$(docker exec procure-app printenv ANTHROPIC_BASE_URL 2>/dev/null)
  if [ -n "$base" ]; then
    ok "ANTHROPIC_BASE_URL=$base (агент в контейнере ходит к этому провайдеру, напр. DeepSeek)"
    if docker exec procure-app sh -c '[ -n "$ANTHROPIC_AUTH_TOKEN" ]' 2>/dev/null; then
      ok "ANTHROPIC_AUTH_TOKEN задан в контейнере (ключ провайдера на месте)"
    else
      bad "ANTHROPIC_AUTH_TOKEN НЕ задан — DeepSeek не авторизуется (заполните .env.prod)"
    fi
  elif docker exec procure-app sh -c '[ -n "$ANTHROPIC_API_KEY" ]' 2>/dev/null; then
    skp "ANTHROPIC_BASE_URL пуст, но есть ANTHROPIC_API_KEY → провайдер Anthropic (допустимо)"
  else
    bad "в контейнере нет ни ANTHROPIC_BASE_URL, ни ANTHROPIC_API_KEY — агенту нечем работать"
  fi
else
  skp "docker/контейнер procure-app недоступен (запустите на сервере) — проверка провайдера пропущена"
fi

echo; echo "=== ИТОГ ==="
echo "OK: $pass   FAIL: $fail   Пропущено: $skip"
if [ "$fail" -eq 0 ]; then
  echo "✅ Результаты задачи подтверждены."
else
  echo "⚠️  Есть строки [FAIL] — скопируйте весь вывод и пришлите."
fi
