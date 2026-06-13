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
#
# Использование:
#   ./scripts/deploy-b24-controller.sh            # dry-run (ничего не меняет)
#   APPLY=1 ./scripts/deploy-b24-controller.sh    # реальная выкладка
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

# rsync БЕЗ --delete — чужие файлы не трогаются.
RSYNC_BASE=(-avz --no-perms --omit-dir-times -e "$SSH_CMD")

if [ "${APPLY:-0}" = "1" ]; then
  echo ">>> APPLY=1 — реальная выкладка"
else
  echo ">>> dry-run (APPLY=1 для реальной выкладки)"
  RSYNC_BASE+=(--dry-run)
fi

# 1) Контроллеры: только procure*.php в lib/controllers/.
rsync "${RSYNC_BASE[@]}" --include='procure*.php' --exclude='*' \
  "$SRC_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_CONTROLLERS_PATH}/"

# 2) Конфиг: только config.php в lib/.
rsync "${RSYNC_BASE[@]}" --include='config.php' --exclude='*' \
  "$LIB_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_LIB_PATH}/"

echo "Готово."
