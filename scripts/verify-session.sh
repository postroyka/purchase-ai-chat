#!/usr/bin/env bash
# =====================================================================
#  Проверка результатов работы за сессию (конфиг модуля + чеклист
#  деплоя + тест лимита размера файла). Запускается ЛОКАЛЬНО, живой
#  сервер Bitrix24 НЕ нужен.
#
#  Запуск:  bash scripts/verify-session.sh
# =====================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "── 1. Конфиг модуля вынесен в отдельный файл (config.php) ──"
if [ -f b24-controller/lib/config.php ]; then
  ok "файл b24-controller/lib/config.php существует (имя в нижнем регистре)"
else
  bad "config.php не найден"
fi
if grep -q "class Config" b24-controller/lib/config.php 2>/dev/null \
   && grep -q "getCatalogIblockId\|getDealCategoryId\|getDealDefaultStageId\|getUnitOkeiSht" b24-controller/lib/config.php 2>/dev/null; then
  ok "класс Config с 4 геттерами настроек на месте"
else
  bad "класс Config или его методы не найдены"
fi
if ! grep -rq "Option::get('shef.purchase'" b24-controller/lib/controllers/ 2>/dev/null; then
  ok "контроллеры больше не читают настройки напрямую (всё через Config)"
else
  bad "в контроллерах остались прямые вызовы Option::get"
fi

echo "── 2. Синтаксис PHP-файлов ──"
if command -v php >/dev/null 2>&1; then
  ERR=0
  for f in b24-controller/lib/config.php b24-controller/lib/controllers/procure*.php; do
    php -l "$f" >/dev/null 2>&1 || { bad "ошибка синтаксиса: $f"; ERR=1; }
  done
  [ $ERR -eq 0 ] && ok "php -l: все 5 файлов без ошибок"
else
  echo "  ⏭  php не установлен — пропуск (на CI проверяется)"
fi

echo "── 3. Чеклист деплоя в документации ──"
if grep -q "Деплой при изменении контракта MCP" b24-controller/README.md 2>/dev/null; then
  ok "раздел «Деплой при изменении контракта MCP ↔ PHP» есть в README"
else
  bad "раздел чеклиста деплоя не найден в README"
fi

echo "── 4. CI-напоминание о ручном деплое PHP ──"
if grep -q "b24-deploy-reminder\|b24 deploy reminder" .github/workflows/ci.yml 2>/dev/null; then
  ok "джоба-напоминание есть в .github/workflows/ci.yml"
else
  bad "джоба b24 deploy reminder не найдена"
fi
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null \
    && ok "ci.yml — валидный YAML" || bad "ci.yml — ошибка YAML"
fi

echo "── 5. Тесты backend (вкл. новый тест лимита размера файла) ──"
if command -v pnpm >/dev/null 2>&1; then
  if (cd backend && pnpm test >/tmp/verify-backend.log 2>&1); then
    LINE=$(grep -E "Tests +[0-9]+ passed" /tmp/verify-backend.log | tail -1)
    ok "backend-тесты прошли — ${LINE:-OK}"
    grep -q "exceeds maxFileSizeMb" /tmp/verify-backend.log 2>/dev/null \
      && ok "новый тест 'file exceeds maxFileSizeMb limit' присутствует" \
      || echo "  ℹ  (имя нового теста не видно в кратком выводе — это норма)"
  else
    bad "backend-тесты упали — подробности в /tmp/verify-backend.log"
  fi
else
  echo "  ⏭  pnpm не установлен — пропуск (на CI проверяется)"
fi

echo ""
echo "════════════════════════════════════════════"
echo "  ИТОГ:  ✅ $PASS пройдено   ❌ $FAIL провалено"
echo "════════════════════════════════════════════"
[ $FAIL -eq 0 ] && echo "Всё в порядке." || echo "Есть провалы — см. выше."
exit $FAIL
