#!/usr/bin/env bash
#
# Полуручной деплой REST-контроллеров procure-ai в коробку Bitrix24.
#
# Копирует наши файлы procure-ai в коробку shef.purchase по SSH:
#   - b24-controller/lib/controllers/procure*.php → <модуль>/lib/controllers/
#   - b24-controller/lib/config.php              → <модуль>/lib/
#
# ⚠️ Модуль shef.purchase — живой код заказчика. Скрипт:
#    - выкладывает только наши файлы (procure*.php + config.php);
#    - rsync БЕЗ --delete — чужие файлы не трогаются и не удаляются;
#    - по умолчанию dry-run; реальная выкладка только при APPLY=1.
#
# Настройки (env или scripts/.env.deploy). Каждую можно задать и с префиксом
# PAI_ (procure-ai namespace) — напр. PAI_B24_SSH_HOST:
#   B24_SSH_HOST          — хост сервера Bitrix24 (обязательно)
#   B24_SSH_USER          — пользователь SSH (обязательно)
#   B24_SSH_PORT          — порт SSH (по умолчанию 22)
#   B24_CONTROLLERS_PATH  — абсолютный путь до .../shef.purchase/lib/controllers
#                           (обязательно)
#   B24_SSH_PASS          — пароль SSH (опц.; нужен пакет sshpass). Если не задан —
#                           используется SSH-ключ/agent. Пароль передаётся через
#                           SSHPASS (sshpass -e), не светится в списке процессов.
#   WEBHOOK_URL / PAI_WEBHOOK_URL — (опц.) REST-вебхук для пост-деплой health-чека
#                           после APPLY: read-only проверка, что все 4 контроллера
#                           зарегистрированы (негативные кейсы; сделки НЕ создаются).
#
# Поведение:
#   - dry-run по умолчанию: rsync СРАВНИВАЕТ с сервером по SSH и печатает список
#     изменений, но НА ДИСК СЕРВЕРА НИЧЕГО НЕ ПИШЕТ;
#   - APPLY=1: реальная выкладка + бэкап прежних версий (мгновенный откат) +
#     пост-деплой health-чек (если задан вебхук).
#
# Использование:
#   ./scripts/deploy-b24-controller.sh            # СИМУЛЯЦИЯ — на сервер не пишет
#   APPLY=1 ./scripts/deploy-b24-controller.sh    # реальная выкладка (+бэкап +health)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_ROOT/b24-controller/lib"
SRC_DIR="$LIB_DIR/controllers"

# Подхватить scripts/.env.deploy, если есть.
if [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env.deploy"; set +a
fi

# Алиасы с префиксом PAI_ (procure-ai namespace), если базовые имена не заданы.
B24_SSH_HOST="${B24_SSH_HOST:-${PAI_B24_SSH_HOST:-}}"
B24_SSH_USER="${B24_SSH_USER:-${PAI_B24_SSH_USER:-}}"
B24_SSH_PORT="${B24_SSH_PORT:-${PAI_B24_SSH_PORT:-}}"
B24_CONTROLLERS_PATH="${B24_CONTROLLERS_PATH:-${PAI_B24_CONTROLLERS_PATH:-}}"
B24_SSH_PASS="${B24_SSH_PASS:-${PAI_B24_SSH_PASS:-}}"

: "${B24_SSH_HOST:?B24_SSH_HOST/PAI_B24_SSH_HOST не задан (env или scripts/.env.deploy)}"
: "${B24_SSH_USER:?B24_SSH_USER/PAI_B24_SSH_USER не задан}"
: "${B24_CONTROLLERS_PATH:?B24_CONTROLLERS_PATH/PAI_B24_CONTROLLERS_PATH не задан}"
B24_SSH_PORT="${B24_SSH_PORT:-22}"

if [ ! -d "$SRC_DIR" ]; then
  echo "Нет каталога с контроллерами: $SRC_DIR" >&2
  exit 1
fi

# Проверка: есть что выкладывать.
shopt -s nullglob
files=("$SRC_DIR"/procure*.php)
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "Не найдено файлов procure*.php в $SRC_DIR" >&2
  exit 1
fi

# Путь до lib/ модуля = родитель lib/controllers (туда кладём config.php).
# Срезаем возможный trailing slash, иначе dirname вернёт сам каталог controllers.
B24_LIB_PATH="$(dirname "${B24_CONTROLLERS_PATH%/}")"

echo "Файлы к выкладке:"
for f in "${files[@]}"; do echo "  - controllers/$(basename "$f")"; done
[ -f "$LIB_DIR/config.php" ] && echo "  - config.php"
echo "Назначение: ${B24_SSH_USER}@${B24_SSH_HOST} (порт ${B24_SSH_PORT})"
echo "  controllers → ${B24_CONTROLLERS_PATH}/"
echo "  config.php  → ${B24_LIB_PATH}/"

# Транспорт SSH. С паролем — через sshpass -e (пароль из env SSHPASS, не в argv).
SSH_CMD="ssh -p ${B24_SSH_PORT}"
if [ -n "${B24_SSH_PASS:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "Задан B24_SSH_PASS, но нет sshpass. Установите sshpass или используйте SSH-ключ." >&2
    exit 1
  fi
  export SSHPASS="$B24_SSH_PASS"
  SSH_CMD="sshpass -e ssh -p ${B24_SSH_PORT}"
fi

# Пост-деплой health: read-only проверка, что все 4 контроллера зарегистрированы.
# Дёргаем негативные кейсы — ждём коды валидации (sup:010/con:010/prd:010/deal:010),
# а НЕ ERROR_METHOD_NOT_FOUND/500. Сделки и любые данные НЕ создаются — безопасно
# в т.ч. на боевой коробке. Запускается после APPLY, если задан вебхук.
postdeploy_health() {
  local hook="${1%/}" fail=0 resp
  _hc() {
    resp=$(curl -s -m 20 -X POST "${hook}/$1" -H 'Content-Type: application/json' -d "$2" 2>/dev/null || true)
    if printf '%s' "$resp" | grep -q "$3"; then
      echo "    OK   $1 → $3"
    else
      echo "    FAIL $1 → ожидали $3, получили: $(printf '%s' "$resp" | tr -d '\n' | head -c 160)"
      fail=1
    fi
  }
  _hc "shef:purchase.api.procuresupplier.findbyunp"       '{"unp":""}'        'sup:010'
  _hc "shef:purchase.api.procurecontract.find"            '{"supplierId":0}'  'con:010'
  _hc "shef:purchase.api.procureproduct.findbyvendorcode" '{"vendorCode":""}' 'prd:010'
  _hc "shef:purchase.api.procuredeal.create"              '{"supplierId":0,"responsibleUserId":1,"fileName":"x","fileContent":"","processingLog":"","items":[{"name":"x","priceExclVat":1,"quantity":1}]}' 'deal:010'
  return $fail
}

# rsync БЕЗ --delete — чужие файлы не трогаются.
RSYNC_BASE=(-avz --no-perms --omit-dir-times -e "$SSH_CMD")

BACKUP_DIR=""
if [ "${APPLY:-0}" = "1" ]; then
  echo ">>> APPLY=1 — реальная выкладка"
  # Бэкап заменяемых файлов на сервере → мгновенный откат. rsync --backup кладёт
  # ПРЕЖНИЕ версии перезаписываемых файлов в backup-dir (только реально изменённые).
  BACKUP_DIR="${B24_LIB_PATH}/.deploy-backup/$(date +%Y%m%d-%H%M%S)"
  RSYNC_BASE+=(--backup --backup-dir="$BACKUP_DIR")
  echo "    бэкап прежних версий → ${BACKUP_DIR}/ (на сервере)"
else
  echo ">>> РЕЖИМ СИМУЛЯЦИИ (rsync --dry-run): идёт сравнение с сервером по SSH,"
  echo "    но НИ ОДИН файл не записывается. Для реальной выкладки: APPLY=1"
  RSYNC_BASE+=(--dry-run --itemize-changes)
fi

# 1) Контроллеры: только procure*.php в lib/controllers/.
rsync "${RSYNC_BASE[@]}" --include='procure*.php' --exclude='*' \
  "$SRC_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_CONTROLLERS_PATH}/"

# 2) Конфиг: только config.php в lib/.
rsync "${RSYNC_BASE[@]}" --include='config.php' --exclude='*' \
  "$LIB_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_LIB_PATH}/"

if [ "${APPLY:-0}" != "1" ]; then
  echo "Симуляция завершена — на сервер НИЧЕГО не записано (см. список изменений выше)."
  exit 0
fi

echo "Файлы выложены."

# Пост-деплой health-чек (read-only). Вебхук — из WEBHOOK_URL/PAI_WEBHOOK_URL.
HOOK="${WEBHOOK_URL:-${PAI_WEBHOOK_URL:-}}"
if [ -n "$HOOK" ]; then
  echo ">>> Пост-деплой health-чек (read-only, сделки не создаются):"
  if postdeploy_health "$HOOK"; then
    echo "Health OK — все 4 контроллера зарегистрированы и отвечают."
  else
    echo "" >&2
    echo "❌ Health-чек не прошёл: контроллер не зарегистрирован или ошибка ядра." >&2
    echo "   Откат: на сервере верните файлы из ${BACKUP_DIR}/" >&2
    exit 1
  fi
else
  echo "(health-чек пропущен — задайте WEBHOOK_URL или PAI_WEBHOOK_URL для авто-проверки)"
fi

echo "Готово."
